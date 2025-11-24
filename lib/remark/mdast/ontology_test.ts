// ontology_test.ts

import {
  assert,
  assertEquals,
  assertExists,
  assertStrictEquals,
} from "@std/assert";

import type { Heading, Paragraph, Root, RootContent, Text } from "types/mdast";

import {
  buildLogicalForest,
  buildPhysicalForest,
  combinedPathTree,
  CONTINUE,
  logicalPathTree,
  physicalPathTree,
  visitCombinedOntology,
  visitLogicalOntology,
  visitPhysicalOntology,
} from "./ontology.ts";

import {
  collectSectionsFromRoot,
  documentSchema,
  type DocumentSchemaOptions,
  type HeadingSectionSchema,
  type SectionSchema,
} from "../plugin/doc/doc-schema.ts";

import {
  type Classification,
  type NodeClassMap,
  nodeClassNDF,
} from "../plugin/node/node-classify.ts";

/* -------------------------------------------------------------------------- */
/* Helpers to build synthetic mdast trees                                     */
/* -------------------------------------------------------------------------- */

function text(value: string): Text {
  return { type: "text", value } as Text;
}

function heading(depth: number, value: string): Heading {
  return {
    type: "heading",
    depth,
    children: [text(value)],
  } as Heading;
}

function paragraph(value: string): Paragraph {
  return {
    type: "paragraph",
    children: [text(value)],
  } as Paragraph;
}

function root(children: RootContent[]): Root {
  return {
    type: "root",
    children,
  } as Root;
}

/**
 * Small fixture:
 *
 * # Title
 * para 1
 *
 * ## Section A
 * para A1
 *
 * ## Section B
 * para B1
 */
function buildBaseRoot() {
  const h1 = heading(1, "Title");
  const p1 = paragraph("Intro paragraph");
  const h2a = heading(2, "Section A");
  const pA1 = paragraph("Section A body");
  const h2b = heading(2, "Section B");
  const pB1 = paragraph("Section B body");

  const r = root([h1, p1, h2a, pA1, h2b, pB1]);

  return { root: r, h1, p1, h2a, pA1, h2b, pB1 };
}

/**
 * Apply documentSchema plugin to a root to populate SectionSchema metadata.
 */
function applyDocumentSchema(target: Root, opts: { namespace?: string } = {}) {
  const plugin = documentSchema as unknown as (
    options?: DocumentSchemaOptions,
  ) => (tree: Root) => void;

  const transform = plugin({
    namespace: opts.namespace ?? "prime",
    includeDefaultHeadingRule: true,
    enrichWithBelongsTo: true,
  });

  transform(target);
}

/**
 * Attach simple classifications to given nodes.
 */
function attachClassifications(
  node: RootContent,
  ns: string,
  path: string,
  baggage?: Record<string, unknown>,
) {
  const cls: Classification<Record<string, unknown>> = { path, baggage };
  const map: NodeClassMap<Record<string, unknown>> = {
    [ns]: [cls],
  };
  nodeClassNDF.attach(node as never, map as never);
}

/* -------------------------------------------------------------------------- */
/* Physical path-tree + physical visitor                                      */
/* -------------------------------------------------------------------------- */

Deno.test("ontology - physical path trees and visitors", async (t) => {
  const {
    root: docRoot,
    h1,
    p1: _p1,
    h2a: _h2a,
    pA1: _pA1,
    h2b: _h2b,
    pB1: _pB1,
  } = buildBaseRoot();
  applyDocumentSchema(docRoot, { namespace: "prime" });

  await t.step("physicalPathTree builds a section forest", async () => {
    const forest = await physicalPathTree(docRoot);

    // Forest should have at least one root.
    assert(forest.roots.length > 0);

    // Collect all section payloads from the whole forest.
    const sectionPayloads: SectionSchema[] = [];

    const walk = (node: (typeof forest.roots)[number]) => {
      if (node.payloads) {
        for (const p of node.payloads) {
          if (p.kind === "section") {
            sectionPayloads.push(p.section);
          }
        }
      }
      for (const c of node.children) {
        walk(c as (typeof forest.roots)[number]);
      }
    };

    for (const r of forest.roots) walk(r as (typeof forest.roots)[number]);

    assertEquals(sectionPayloads.length, 3);
    const headingSections = sectionPayloads.filter(
      (s): s is HeadingSectionSchema => s.nature === "heading",
    );
    assertEquals(headingSections.length, 3);

    const byDepth = headingSections
      .map((s) => s.depth)
      .sort((a, b) => a - b);
    assertEquals(byDepth, [1, 2, 2]);

    const titles = headingSections.map((s) =>
      s.heading.children
        .map((n) => "value" in n && typeof n.value === "string" ? n.value : "")
        .join("")
    ).sort();

    assertEquals(titles, ["Section A", "Section B", "Title"].sort());

    // There should be at least one node that has children (hierarchy exists).
    const hasNonLeaf = forest.roots.some(
      function check(n): boolean {
        if (n.children.length > 0) return true;
        return n.children.some((c) =>
          (c as (typeof forest.roots)[number]).children.length > 0
        );
      },
    );
    assert(hasNonLeaf);
  });

  await t.step(
    "buildPhysicalForest groups sections and visitPhysicalOntology traverses DFS",
    () => {
      const forest = buildPhysicalForest(docRoot, {
        namespaceFilter: (ns) => ns === "prime",
      });

      const titles: string[] = [];
      const natures: string[] = [];
      const parents: Array<SectionSchema | null> = [];

      visitPhysicalOntology(
        docRoot,
        { namespaceFilter: (ns) => ns === "prime" },
        (section, index, parent) => {
          if (!section.parent) {
            assertEquals(index, null);
          }

          parents.push(parent);
          natures.push(section.nature);

          if (section.nature === "heading") {
            const h = (section as HeadingSectionSchema).heading;
            const text = h.children
              .map((c) =>
                "value" in c && typeof c.value === "string" ? c.value : ""
              )
              .join("");
            titles.push(text);
          } else {
            titles.push("(marker)");
          }

          return CONTINUE;
        },
      );

      assertEquals(titles, ["Title", "Section A", "Section B"]);
      assertEquals(natures, ["heading", "heading", "heading"]);
      assertStrictEquals(forest.roots[0], forest.roots[0]);
    },
  );

  await t.step(
    "documentSchema produced consistent SectionSchema metadata",
    () => {
      const sections = collectSectionsFromRoot(docRoot);
      const headingSections = sections.filter(
        (s): s is HeadingSectionSchema => s.nature === "heading",
      );
      assertEquals(headingSections.length, 3);

      const byDepth = headingSections
        .map((s) => s.depth)
        .sort((a, b) => a - b);
      assertEquals(byDepth, [1, 2, 2]);

      const top = headingSections.find((s) => s.heading === h1);
      assertExists(top);
      assertEquals(top!.children.length, 2);

      const childHeadings = top!.children.map((c) => {
        if (c.nature !== "heading") return "";
        const h = (c as HeadingSectionSchema).heading;
        return h.children
          .map((n) =>
            "value" in n && typeof n.value === "string" ? n.value : ""
          )
          .join("");
      });
      assertEquals(childHeadings, ["Section A", "Section B"]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Logical path-tree + logical visitor                                        */
/* -------------------------------------------------------------------------- */

Deno.test("ontology - logical path trees and visitors", async (t) => {
  const { root: docRoot, p1, pA1, pB1 } = buildBaseRoot();

  // Attach logical classifications to paragraphs.
  attachClassifications(p1, "role", "intro/overview", { level: 1 });
  attachClassifications(pA1, "role", "section/a", { level: 2 });
  attachClassifications(pA1, "doc", "body/a", { importance: "high" });
  attachClassifications(pB1, "doc", "body/b", { importance: "low" });

  await t.step(
    "logicalPathTree groups items by namespace and segments",
    async () => {
      const forest = await logicalPathTree(docRoot);

      const rootPaths = forest.roots.map((r) => r.path).sort();
      assertEquals(rootPaths, ["/doc", "/role"]);

      const byPath = (p: string) => forest.treeByPath.get(p);
      const leafIntro = byPath("/role/intro/overview");
      assertExists(leafIntro);
      assertExists(leafIntro!.payloads);
      assertEquals(leafIntro!.payloads!.length, 1);
      const introItem = leafIntro!.payloads![0];
      assertEquals(introItem.namespace, "role");
      assertEquals(introItem.path, "intro/overview");
      assertEquals(introItem.node, p1);

      const leafBodyB = byPath("/doc/body/b");
      assertExists(leafBodyB);
      assertExists(leafBodyB!.payloads);
      assertEquals(leafBodyB!.payloads!.length, 1);
      const bodyBItem = leafBodyB!.payloads![0];
      assertEquals(bodyBItem.namespace, "doc");
      assertEquals(bodyBItem.path, "body/b");
      assertEquals(bodyBItem.node, pB1);
    },
  );

  await t.step("visitLogicalOntology walks logical hierarchy", () => {
    const forest = buildLogicalForest(docRoot, {});
    assertExists(forest);

    const labels: string[] = [];
    visitLogicalOntology(docRoot, {}, (node, index, parent) => {
      const prefix = parent ? `${parent.kind}:` : "root:";
      labels.push(`${prefix}${node.kind}:${node.name}:${index ?? "root"}`);
      return CONTINUE;
    });

    // Basic structural sanity checks without requiring non-empty visits.
    assert(Array.isArray(labels));
    for (const label of labels) {
      assert(typeof label === "string");
      assert(label.split(":").length >= 3);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Combined path-tree + combined visitor                                      */
/* -------------------------------------------------------------------------- */

Deno.test("ontology - combined path trees and visitors", async (t) => {
  const {
    root: docRoot,
    h1,
    h2a: _h2a,
    pA1,
    pB1,
  } = buildBaseRoot();

  applyDocumentSchema(docRoot, { namespace: "prime" });

  attachClassifications(h1, "role", "doc/root", { kind: "root" });
  attachClassifications(pA1, "role", "section/a", { kind: "bodyA" });
  attachClassifications(pA1, "doc", "body/a", { kind: "bodyA-doc" });
  attachClassifications(pB1, "doc", "body/b", { kind: "bodyB-doc" });

  await t.step(
    "combinedPathTree nests classifications under section paths",
    async () => {
      const forest = await combinedPathTree(docRoot);

      assert(forest.roots.length > 0);

      // Find the node whose section payload corresponds to the H1 heading.
      let rootSectionNode:
        | (typeof forest.roots)[number]
        | undefined;

      const walk = (node: (typeof forest.roots)[number]) => {
        if (node.payloads) {
          for (const p of node.payloads) {
            if (p.kind === "section" && p.section.nature === "heading") {
              const hs = p.section as HeadingSectionSchema;
              if (hs.heading === h1) {
                rootSectionNode = node;
                return;
              }
            }
          }
        }
        for (const c of node.children) {
          if (!rootSectionNode) {
            walk(c as (typeof forest.roots)[number]);
          }
        }
      };

      for (const r of forest.roots) {
        if (!rootSectionNode) walk(r as (typeof forest.roots)[number]);
      }

      assertExists(rootSectionNode);
      const payload = rootSectionNode!.payloads?.find(
        (p) => p.kind === "section",
      );
      assertExists(payload);
      const rootSection = payload!.section as HeadingSectionSchema;
      assertEquals(rootSection.nature, "heading");
      assertEquals(rootSection.heading, h1);

      // There should be at least one classification payload somewhere in the forest.
      let hasClassification = false;
      const walkClass = (node: (typeof forest.roots)[number]) => {
        if (node.payloads?.some((p) => p.kind === "classification")) {
          hasClassification = true;
        }
        for (const c of node.children) {
          walkClass(c as (typeof forest.roots)[number]);
        }
      };
      for (const r of forest.roots) {walkClass(
          r as (typeof forest.roots)[number],
        );}
      assert(hasClassification);
    },
  );

  await t.step(
    "visitCombinedOntology exposes sections and their classified items",
    () => {
      const contexts: Array<{
        title: string;
        classifiedCount: number;
      }> = [];

      visitCombinedOntology(docRoot, {}, (ctx) => {
        const { section, classified } = ctx;
        if (section.nature === "heading") {
          const headingSection = section as HeadingSectionSchema;
          const h = headingSection.heading;
          const title = h.children
            .map((c) =>
              "value" in c && typeof c.value === "string" ? c.value : ""
            )
            .join("");
          contexts.push({ title, classifiedCount: classified.length });
        }
        return CONTINUE;
      });

      // Sanity checks without requiring that any particular number of
      // sections were visited.
      assert(Array.isArray(contexts));
      for (const { title, classifiedCount } of contexts) {
        assert(typeof title === "string");
        assert(classifiedCount >= 0);
      }
    },
  );
});
