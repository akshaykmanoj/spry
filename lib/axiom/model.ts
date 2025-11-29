// model.ts
//
// Deno entrypoint for the Spry Graph Viewer.
// - Reads Markdown fixture(s)
// - Runs the Ontology Graphs and Edges rule pipeline
// - Builds a GraphViewerModel (graph-centric JSON)
// - Injects that JSON into index.html and serves it via Deno.serve

import { toMarkdown } from "mdast-util-to-markdown";
import type { Heading, Paragraph, Root } from "types/mdast";
import type { Node } from "types/unist";
import { queryPosixPI } from "../universal/posix-pi.ts";
import { type GraphEdgesTree, graphEdgesTree } from "./graph-tree.ts";
import {
  containedInSectionRule,
  createGraphRulesBuilder,
  frontmatterClassificationRule,
  GraphEdge,
  headingLikeNodeDataBag,
  headingText,
  isBoldSingleLineParagraph,
  isColonSingleLineParagraph,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  sectionSemanticIdRule,
  selectedNodesClassificationRule,
} from "./graph.ts";
import { codeFrontmatter } from "./mdast/code-frontmatter.ts";
import { isCodePartial } from "./remark/code-partial.ts";

export type ModelRelationship = string;

export type ModelGraphEdge = GraphEdge<ModelRelationship>;
export type ModelRuleCtx = RuleContext;

// -----------------------------------------------------------------------------
// Section container callback (headings + heading-like paragraphs)
// -----------------------------------------------------------------------------

const headingLikeSectionContainer: IsSectionContainer = (node: Node) => {
  if (node.type === "heading") {
    return {
      nature: "heading" as const,
      label: headingText(node),
      mdLabel: toMarkdown(node as Heading),
    };
  }

  if (node.type !== "paragraph") return false;

  const candidate = isBoldSingleLineParagraph(node as Paragraph) ??
    isColonSingleLineParagraph(node as Paragraph);

  if (!candidate) return false;

  headingLikeNodeDataBag.attach(node, true);
  return {
    nature: "section" as const,
    ...candidate,
  };
};

// -----------------------------------------------------------------------------
// Build the rule pipeline (same as Ontology Graphs and Edges test)
// -----------------------------------------------------------------------------

export function buildRules() {
  const builder = createGraphRulesBuilder<
    ModelRelationship,
    ModelRuleCtx,
    ModelGraphEdge
  >();

  return builder
    .use(
      containedInSectionRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "containedInSection",
        headingLikeSectionContainer,
      ),
    )
    .use(
      sectionFrontmatterRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "frontmatter",
        ["containedInSection"] as ModelRelationship[],
      ),
    )
    .use(
      sectionSemanticIdRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "sectionSemanticId",
        ["containedInSection"] as ModelRelationship[],
      ),
    )
    .use(
      frontmatterClassificationRule<
        ModelRelationship,
        ModelRuleCtx,
        ModelGraphEdge
      >("doc-classify"),
    )
    .use(
      selectedNodesClassificationRule<
        ModelRelationship,
        ModelRuleCtx,
        ModelGraphEdge
      >("emphasis", "isImportant"),
    )
    .use(
      nodesClassificationRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "isCode",
        (node) => node.type === "code",
      ),
    )
    .use(
      nodesClassificationRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "isPartial",
        (node) => isCodePartial(node) ? true : false,
      ),
    )
    .use(
      nodesClassificationRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "isTask",
        (node) => node.type === "listItem",
      ),
    )
    .use(
      nodeDependencyRule<ModelRelationship, ModelRuleCtx, ModelGraphEdge>(
        "codeDependsOn",
        (node): boolean => node.type === "code",
        (node, name): boolean => {
          const codeFM = codeFrontmatter(node);
          if (!codeFM) return false;
          return codeFM.pi.pos[0] == name;
        },
        (node) => {
          const codeFM = codeFrontmatter(node);
          if (!codeFM) return false;
          const qf = queryPosixPI(codeFM.pi);
          const deps = qf.getTextFlagValues("dep");
          return deps.length > 0 ? deps : false;
        },
      ),
    )
    .build();
}

// -----------------------------------------------------------------------------
// Build GraphEdgesTree for one markdown Root using `containedInSection`
// -----------------------------------------------------------------------------

export function buildGraphTreeForRoot(
  _root: Root,
  edges: ModelGraphEdge[],
): GraphEdgesTree<
  ModelRelationship,
  ModelGraphEdge
> {
  return graphEdgesTree<ModelRelationship, ModelGraphEdge>(edges, {
    relationships: ["containedInSection"],
  });
}
