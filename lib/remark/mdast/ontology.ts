/**
 * @module ontology
 *
 * High-level “document ontology” utilities that unify two independent
 * structural descriptions of a Markdown document:
 *
 *   1. **Physical schema** – derived from the document’s *visible* structure
 *      (headings, sections, and marker-based regions) as emitted by
 *      `doc-schema.ts`.
 *
 *   2. **Logical schema** – derived from arbitrary *semantic classifications*
 *      attached to mdast nodes using the `node-classify.ts` system.
 *
 * This module produces a coherent “ontology” of a document by exposing:
 *
 * -----------------------------------------------------------------------------
 * PHYSICAL ONTOLOGY
 * -----------------------------------------------------------------------------
 *
 * ### `physicalPathTree(root)`
 * Builds a hierarchical `PathTree` using the physical *section structure*
 * defined by `doc-schema.ts`. Paths reflect the physical TOC-like structure,
 * for example:
 *
 * ```
 * /prime/Title
 * /prime/Title/Section A
 * /prime/Title/Section B
 * ```
 *
 * ### `buildPhysicalForest(root, opts)`
 * Produces a normalized forest of section nodes for DFS visiting.
 *
 * ### `visitPhysicalOntology(root, opts, visitor)`
 * A simple depth-first traversal over section nodes.
 * This is the easiest way to walk the physical “outline” of the document.
 *
 * -----------------------------------------------------------------------------
 * LOGICAL ONTOLOGY
 * -----------------------------------------------------------------------------
 *
 * ### `logicalPathTree(root)`
 * Builds a path tree from classifier namespaces and their paths, such as:
 *
 * ```
 * /role/intro/overview
 * /role/section/a
 * /doc/body/a
 * /doc/body/b
 * ```
 *
 * ### `buildLogicalForest(root, opts)`
 * Produces a normalized forest of classifier nodes.
 *
 * ### `visitLogicalOntology(root, opts, visitor)`
 * Traverses logical classifications in DFS order.
 *
 * -----------------------------------------------------------------------------
 * COMBINED ONTOLOGY
 * -----------------------------------------------------------------------------
 *
 * The combined ontology unifies physical *sections* and logical
 * *classifications* by placing classification paths *under* the section that
 * physically contains the classified node.
 *
 * Example:
 *
 * ```
 * /prime/Title
 *   (section)
 *   /role/doc/root
 *   /doc/body/a
 * /prime/Title/Section A
 *   (section)
 *   /role/section/a
 *   /doc/body/a
 * ```
 *
 * ### `combinedPathTree(root)`
 * Produces a merged path tree where physical sections are parents for all
 * classifications whose nodes fall inside them.
 *
 * ### `visitCombinedOntology(root, opts, visitor)`
 * Traverses combined physical/logical ontology. Each visit callback receives:
 *
 *   - the section
 *   - all logical classifications physically contained in that section
 *
 * -----------------------------------------------------------------------------
 * DESIGN PHILOSOPHY
 * -----------------------------------------------------------------------------
 *
 * This module provides two complementary “views”:
 *
 * - **Path-tree view**: ideal for hierarchical graph processing, indexing,
 *   debugging, or visualization.
 *
 * - **Visitor view**: ideal for simple top-down “walks” without needing the
 *   path tree. These also allow differential or incremental processing.
 *
 * Both systems produce parallel but consistent interpretations of the same mdast
 * root, and both can be used in the same program without conflict.
 *
 * -----------------------------------------------------------------------------
 * LEARNING AND EXAMPLES
 * -----------------------------------------------------------------------------
 *
 * The best way to understand usage is to read the accompanying test suite
 * `ontology_test.ts`. It provides:
 *
 *   - synthetic mdast trees
 *   - physical schema examples
 *   - logical classification examples
 *   - combined ontology exercises
 *   - practical traversal patterns
 *
 * The test cases are intentionally designed as a tutorial —
 * they are the clearest reference for real-world usage patterns.
 */
import type { Root, RootContent } from "types/mdast";
import type { Data } from "types/unist";
import { CONTINUE, EXIT, SKIP } from "unist-util-visit";

import {
  type Classification,
  type ClassificationNamespace,
  type ClassificationPath,
  type NodeClassMap,
  nodeClassNDF,
  type RootNode,
} from "../plugin/node/node-classify.ts";

import {
  collectSectionsFromRoot,
  hasBelongsToSection,
  hasSectionSchema,
  type SectionSchema,
} from "../plugin/doc/doc-schema.ts";

import { pathTree, type PathTreeNode } from "../../universal/path-tree.ts";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Slugify a string for use in ontology paths (simple, predictable).
 */
function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}

/**
 * Extract a "title" from a SectionSchema for slug generation.
 */
function sectionTitle(section: SectionSchema): string {
  if (section.nature === "heading") {
    const h = section.heading;
    const texts = h.children
      .map((c) => ("value" in c && typeof c.value === "string" ? c.value : ""))
      .join(" ");
    return texts || "section";
  }

  const m = section.markerNode;
  if ("value" in m && typeof m.value === "string") {
    return m.value;
  }
  if ("children" in m && Array.isArray(m.children)) {
    const texts = m.children
      // deno-lint-ignore no-explicit-any
      .map((c: any) =>
        "value" in c && typeof c.value === "string" ? c.value : ""
      )
      .join(" ");
    return texts || "section";
  }
  return "section";
}

/**
 * Extract the best-effort textual label for a classification path leaf.
 */
function classificationLabel(path: ClassificationPath): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * Safe iteration over a node's children.
 */
// deno-lint-ignore no-explicit-any
function childrenOf(n: any): RootContent[] {
  return Array.isArray(n?.children) ? (n.children as RootContent[]) : [];
}

/* -------------------------------------------------------------------------- */
/* Logical items (ClassifiedItem)                                            */
/* -------------------------------------------------------------------------- */

export interface ClassifiedItem<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly namespace: ClassificationNamespace;
  readonly path: ClassificationPath;
  readonly fullPath: ClassificationPath;
  readonly baggage?: Baggage;
  readonly node: RootNode;
}

/**
 * Extract all ClassifiedItems from a root, optionally filtered by namespace.
 */
function collectClassifiedItems<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: {
    namespaceFilter?: (ns: ClassificationNamespace) => boolean;
    pathPrefix?: string;
  } = {},
): ClassifiedItem<Baggage>[] {
  const { namespaceFilter, pathPrefix } = options;
  const items: ClassifiedItem<Baggage>[] = [];

  const stack: RootContent[] = childrenOf(root);
  while (stack.length) {
    const node = stack.pop() as RootContent;
    stack.push(...childrenOf(node));

    if (!nodeClassNDF.is(node as unknown as RootNode)) continue;

    const classMap = nodeClassNDF.get(node as unknown as RootNode) as
      | NodeClassMap<Baggage>
      | undefined;
    if (!classMap) continue;

    for (const [namespace, classList] of Object.entries(classMap)) {
      const ns = namespace as ClassificationNamespace;
      if (namespaceFilter && !namespaceFilter(ns)) continue;

      for (const cls of classList as Classification<Baggage>[]) {
        const { path, baggage } = cls;
        const segments = [pathPrefix, ns, path].filter(Boolean) as string[];
        const fullPath = (`/${segments.join("/")}`) as ClassificationPath;

        items.push({
          namespace: ns,
          path,
          fullPath,
          baggage,
          node: node as RootNode,
        });
      }
    }
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* 1. Physical schema → path tree                                             */
/* -------------------------------------------------------------------------- */

export interface PhysicalPathTreeOptions {
  readonly namespaceFilter?: (ns: string) => boolean;
  readonly pathPrefix?: string;
}

export interface PhysicalSectionPayload {
  readonly kind: "section";
  readonly section: SectionSchema;
  readonly slug: string;
  readonly path: string;
}

export type PhysicalPathTreeNode = PathTreeNode<PhysicalSectionPayload, string>;

/**
 * Build a pathTree view over physical document structure (sections/headings).
 */
export async function physicalPathTree(
  root: Root,
  options: PhysicalPathTreeOptions = {},
) {
  const { namespaceFilter, pathPrefix } = options;
  const sections = collectSectionsFromRoot(root).filter((s) =>
    namespaceFilter ? namespaceFilter(s.namespace) : true
  );

  const sectionToPath = new Map<SectionSchema, string>();

  const getSectionPath = (section: SectionSchema): string => {
    const cached = sectionToPath.get(section);
    if (cached) return cached;

    const pieces: string[] = [];

    if (pathPrefix) pieces.push(pathPrefix);
    pieces.push(section.namespace);

    // Climb parent chain to build hierarchical path
    const ancestors: SectionSchema[] = [];
    let cur: SectionSchema | undefined | null = section;
    while (cur) {
      ancestors.push(cur);
      cur = cur.parent ?? undefined;
    }
    ancestors.reverse();

    for (const s of ancestors) {
      pieces.push(slugify(sectionTitle(s)));
    }

    const full = `/${pieces.join("/")}`;
    sectionToPath.set(section, full);
    return full;
  };

  const payloads: PhysicalSectionPayload[] = sections.map((section) => {
    const path = getSectionPath(section);
    const slug = slugify(sectionTitle(section));
    return {
      kind: "section",
      section,
      slug,
      path,
    };
  });

  return await pathTree<PhysicalSectionPayload, string>(payloads, {
    nodePath: (p) => p.path,
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Logical schema → path tree                                              */
/* -------------------------------------------------------------------------- */

export interface LogicalPathTreeOptions<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly pathDelim?: string;
  readonly synthesizeContainers?: boolean;
  readonly indexBasenames?: string[];
  readonly folderFirst?: boolean;
  readonly compare?: (
    a: PathTreeNode<ClassifiedItem<Baggage>, string>,
    b: PathTreeNode<ClassifiedItem<Baggage>, string>,
  ) => number;
  readonly forceAbsolute?: boolean;
  readonly namespaceFilter?: (ns: ClassificationNamespace) => boolean;
  readonly pathPrefix?: string;
}

export type LogicalPathTreeNode<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = PathTreeNode<ClassifiedItem<Baggage>, string>;

/**
 * Build a pathTree view over logical document structure (classifications).
 */
export async function logicalPathTree<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: LogicalPathTreeOptions<Baggage> = {},
) {
  const {
    pathDelim,
    synthesizeContainers,
    indexBasenames,
    folderFirst,
    compare,
    forceAbsolute,
    namespaceFilter,
    pathPrefix,
  } = options;

  const items = collectClassifiedItems<Baggage>(root, {
    namespaceFilter,
    pathPrefix,
  });

  return await pathTree<ClassifiedItem<Baggage>, string>(items, {
    nodePath: (i) => i.fullPath,
    pathDelim,
    synthesizeContainers,
    indexBasenames,
    folderFirst,
    compare,
    forceAbsolute,
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Combined physical + logical → path tree (Option B)                      */
/* -------------------------------------------------------------------------- */

export interface CombinedPathTreeOptions<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly sectionNamespaceFilter?: (ns: string) => boolean;
  readonly classificationNamespaceFilter?: (
    ns: ClassificationNamespace,
  ) => boolean;
  readonly pathPrefixSections?: string;
  readonly pathPrefixClasses?: string;
  readonly pathDelim?: string;
  readonly synthesizeContainers?: boolean;
  readonly indexBasenames?: string[];
  readonly folderFirst?: boolean;
  readonly compare?: (
    a: PathTreeNode<CombinedPayload<Baggage>, string>,
    b: PathTreeNode<CombinedPayload<Baggage>, string>,
  ) => number;
  readonly forceAbsolute?: boolean;
}

export interface CombinedSectionPayload {
  readonly kind: "section";
  readonly section: SectionSchema;
  readonly slug: string;
  readonly path: string;
}

export interface CombinedClassificationPayload<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "classification";
  readonly item: ClassifiedItem<Baggage>;
  readonly section: SectionSchema;
  readonly path: string;
}

export type CombinedPayload<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = CombinedSectionPayload | CombinedClassificationPayload<Baggage>;

export type CombinedPathTreeNode<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = PathTreeNode<CombinedPayload<Baggage>, string>;

/**
 * Build a combined pathTree where sections are primary containers and
 * classified items appear as children under their owning section node.
 */
export async function combinedPathTree<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: CombinedPathTreeOptions<Baggage> = {},
) {
  const {
    sectionNamespaceFilter,
    classificationNamespaceFilter,
    pathPrefixSections,
    pathPrefixClasses,
    pathDelim,
    synthesizeContainers,
    indexBasenames,
    folderFirst,
    compare,
    forceAbsolute,
  } = options;

  const sections = collectSectionsFromRoot(root).filter((s) =>
    sectionNamespaceFilter ? sectionNamespaceFilter(s.namespace) : true
  );

  const sectionToPath = new Map<SectionSchema, string>();

  const getSectionPath = (section: SectionSchema): string => {
    const cached = sectionToPath.get(section);
    if (cached) return cached;

    const pieces: string[] = [];
    if (pathPrefixSections) pieces.push(pathPrefixSections);
    pieces.push(section.namespace);

    const ancestors: SectionSchema[] = [];
    let cur: SectionSchema | undefined | null = section;
    while (cur) {
      ancestors.push(cur);
      cur = cur.parent ?? undefined;
    }
    ancestors.reverse();

    for (const s of ancestors) {
      pieces.push(slugify(sectionTitle(s)));
    }

    const full = `/${pieces.join("/")}`;
    sectionToPath.set(section, full);
    return full;
  };

  const items = collectClassifiedItems<Baggage>(root, {
    namespaceFilter: classificationNamespaceFilter,
  });

  const sectionMap = new Map<SectionSchema, ClassifiedItem<Baggage>[]>();

  const attachToSection = (
    section: SectionSchema,
    item: ClassifiedItem<Baggage>,
  ) => {
    let bucket = sectionMap.get(section);
    if (!bucket) {
      bucket = [];
      sectionMap.set(section, bucket);
    }
    bucket.push(item);
  };

  // Try to associate each item with a section via belongsToSection or sectionSchema.
  for (const item of items) {
    const node = item.node as unknown as RootContent;
    const sectionCandidates: SectionSchema[] = [];

    if (hasBelongsToSection(node)) {
      const belongs = (node.data as Data & {
        belongsToSection: Record<string, SectionSchema>;
      }).belongsToSection;
      for (const s of Object.values(belongs)) {
        if (!sectionNamespaceFilter || sectionNamespaceFilter(s.namespace)) {
          sectionCandidates.push(s);
        }
      }
    } else if (hasSectionSchema(node)) {
      const catalog = (node.data as Data & {
        sectionSchema: Record<string, SectionSchema>;
      }).sectionSchema;
      for (const s of Object.values(catalog)) {
        if (!sectionNamespaceFilter || sectionNamespaceFilter(s.namespace)) {
          sectionCandidates.push(s);
        }
      }
    }

    for (const s of sectionCandidates) {
      attachToSection(s, item);
    }
  }

  const payloads: CombinedPayload<Baggage>[] = [];

  // Section payloads
  for (const section of sections) {
    const secPath = getSectionPath(section);
    const slug = slugify(sectionTitle(section));
    payloads.push({
      kind: "section",
      section,
      slug,
      path: secPath,
    });

    const classifiedItems = sectionMap.get(section) ?? [];
    for (const item of classifiedItems) {
      const classSegments: string[] = [];
      if (pathPrefixClasses) classSegments.push(pathPrefixClasses);
      classSegments.push("class", item.namespace);

      const pathParts = item.path.split("/").filter(Boolean);
      classSegments.push(...pathParts.map((p) => slugify(p)));

      const classPath = `${secPath}/${classSegments.join("/")}`;

      payloads.push({
        kind: "classification",
        item,
        section,
        path: classPath,
      });
    }
  }

  return await pathTree<CombinedPayload<Baggage>, string>(payloads, {
    nodePath: (p) => p.path,
    pathDelim,
    synthesizeContainers,
    indexBasenames,
    folderFirst,
    compare,
    forceAbsolute,
  });
}

/* -------------------------------------------------------------------------- */
/* 4. Physical ontology visitor (no pathTree)                                 */
/* -------------------------------------------------------------------------- */

export type PhysicalVisitResult =
  | void
  | typeof CONTINUE
  | typeof SKIP
  | typeof EXIT;

export type PhysicalVisitor = (
  section: SectionSchema,
  index: number | null,
  parent: SectionSchema | null,
) => PhysicalVisitResult;

export interface PhysicalForest {
  readonly sections: readonly SectionSchema[];
  readonly roots: readonly SectionSchema[];
  readonly byNamespace: ReadonlyMap<string, SectionSchema[]>;
}

export interface PhysicalOntologyOptions {
  readonly namespaceFilter?: (ns: string) => boolean;
}

/**
 * Build a lightweight forest of sections for visitor-style traversal.
 */
export function buildPhysicalForest(
  root: Root,
  options: PhysicalOntologyOptions = {},
): PhysicalForest {
  const { namespaceFilter } = options;
  const all = collectSectionsFromRoot(root).filter((s) =>
    namespaceFilter ? namespaceFilter(s.namespace) : true
  );

  const byNs = new Map<string, SectionSchema[]>();
  for (const s of all) {
    let bucket = byNs.get(s.namespace);
    if (!bucket) {
      bucket = [];
      byNs.set(s.namespace, bucket);
    }
    bucket.push(s);
  }

  const roots = all.filter((s) => !s.parent);

  return {
    sections: all,
    roots,
    byNamespace: byNs,
  };
}

/**
 * Depth-first traversal over the physical section hierarchy.
 */
export function visitPhysicalOntology(
  root: Root,
  options: PhysicalOntologyOptions,
  visitor: PhysicalVisitor,
): void {
  const forest = buildPhysicalForest(root, options);

  const walk = (
    section: SectionSchema,
    index: number,
    parent: SectionSchema | null,
  ): typeof CONTINUE | typeof EXIT => {
    const res = visitor(section, parent ? index : null, parent);
    if (res === EXIT) return EXIT;
    if (res === SKIP) return CONTINUE;

    const children = section.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const r = walk(child, i, section);
      if (r === EXIT) return EXIT;
    }
    return CONTINUE;
  };

  const roots = forest.roots;
  for (let i = 0; i < roots.length; i++) {
    const r = walk(roots[i], i, null);
    if (r === EXIT) break;
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Logical ontology visitor (logical forest, no pathTree)                  */
/* -------------------------------------------------------------------------- */

export type LogicalVisitResult =
  | void
  | typeof CONTINUE
  | typeof SKIP
  | typeof EXIT;

export interface LogicalNode<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "namespace" | "segment" | "leaf";
  readonly name: string;
  readonly path: string;
  readonly namespace?: ClassificationNamespace;
  readonly items?: ClassifiedItem<Baggage>[];
  readonly children: LogicalNode<Baggage>[];
}

export type LogicalVisitor<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = (
  node: LogicalNode<Baggage>,
  index: number | null,
  parent: LogicalNode<Baggage> | null,
) => LogicalVisitResult;

export interface LogicalForest<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly roots: readonly LogicalNode<Baggage>[];
  readonly items: readonly ClassifiedItem<Baggage>[];
}

export interface LogicalOntologyOptions<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly namespaceFilter?: (ns: ClassificationNamespace) => boolean;
  readonly pathPrefix?: string;
}

/**
 * Build a hierarchical logical forest from classification paths (namespace +
 * "/"-delimited segments).
 */
export function buildLogicalForest<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: LogicalOntologyOptions<Baggage> = {},
): LogicalForest<Baggage> {
  const { namespaceFilter, pathPrefix } = options;
  const items = collectClassifiedItems<Baggage>(root, {
    namespaceFilter,
    pathPrefix,
  });

  const roots: LogicalNode<Baggage>[] = [];
  const nsMap = new Map<string, LogicalNode<Baggage>>();

  for (const item of items) {
    const nsName = item.namespace;
    let nsNode = nsMap.get(nsName);
    if (!nsNode) {
      nsNode = {
        kind: "namespace",
        name: nsName,
        path: nsName,
        namespace: nsName,
        children: [],
      };
      nsMap.set(nsName, nsNode);
      roots.push(nsNode);
    }

    const segments = item.path.split("/").filter(Boolean);
    let parent: LogicalNode<Baggage> = nsNode;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLeaf = i === segments.length - 1;

      if (isLeaf) {
        const label = classificationLabel(item.path);
        const nodePath = `${nsNode.path}/${item.path}`;
        let leaf = parent.children.find((c) =>
          c.kind === "leaf" && c.name === label
        ) as LogicalNode<Baggage> | undefined;

        if (!leaf) {
          leaf = {
            kind: "leaf",
            name: label,
            path: nodePath,
            namespace: nsName,
            items: [],
            children: [],
          };
          parent.children.push(leaf);
        }
        (leaf.items as ClassifiedItem<Baggage>[]).push(item);
      } else {
        const segPath = `${parent.path}/${seg}`;
        let segNode = parent.children.find((c) =>
          c.kind === "segment" && c.name === seg
        ) as LogicalNode<Baggage> | undefined;

        if (!segNode) {
          segNode = {
            kind: "segment",
            name: seg,
            path: segPath,
            namespace: nsName,
            children: [],
          };
          parent.children.push(segNode);
        }
        parent = segNode;
      }
    }
  }

  return { roots, items };
}

/**
 * Depth-first traversal over the logical ontology forest.
 */
export function visitLogicalOntology<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: LogicalOntologyOptions<Baggage>,
  visitor: LogicalVisitor<Baggage>,
): void {
  const forest = buildLogicalForest<Baggage>(root, options);

  const walk = (
    node: LogicalNode<Baggage>,
    index: number,
    parent: LogicalNode<Baggage> | null,
  ): typeof CONTINUE | typeof EXIT => {
    const res = visitor(node, parent ? index : null, parent);
    if (res === EXIT) return EXIT;
    if (res === SKIP) return CONTINUE;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const r = walk(child, i, node);
      if (r === EXIT) return EXIT;
    }
    return CONTINUE;
  };

  for (let i = 0; i < forest.roots.length; i++) {
    const r = walk(forest.roots[i], i, null);
    if (r === EXIT) break;
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Combined ontology visitor (physical + logical, no pathTree)             */
/* -------------------------------------------------------------------------- */

export type CombinedVisitResult =
  | void
  | typeof CONTINUE
  | typeof SKIP
  | typeof EXIT;

export interface CombinedVisitContext<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly section: SectionSchema;
  readonly classified: readonly ClassifiedItem<Baggage>[];
  readonly ancestors: readonly SectionSchema[];
  readonly index: number | null;
  readonly parent: SectionSchema | null;
}

export type CombinedVisitor<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: CombinedVisitContext<Baggage>) => CombinedVisitResult;

export interface CombinedOntologyOptions<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly sectionNamespaceFilter?: (ns: string) => boolean;
  readonly classificationNamespaceFilter?: (
    ns: ClassificationNamespace,
  ) => boolean;
}

/**
 * Build a mapping from SectionSchema → ClassifiedItem[] for combined views.
 */
function buildSectionClassificationMap<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: CombinedOntologyOptions<Baggage>,
): Map<SectionSchema, ClassifiedItem<Baggage>[]> {
  const { sectionNamespaceFilter, classificationNamespaceFilter } = options;

  const items = collectClassifiedItems<Baggage>(root, {
    namespaceFilter: classificationNamespaceFilter,
  });

  const sectionMap = new Map<SectionSchema, ClassifiedItem<Baggage>[]>();

  const attachToSection = (
    section: SectionSchema,
    item: ClassifiedItem<Baggage>,
  ) => {
    let bucket = sectionMap.get(section);
    if (!bucket) {
      bucket = [];
      sectionMap.set(section, bucket);
    }
    bucket.push(item);
  };

  for (const item of items) {
    const node = item.node as unknown as RootContent;
    const candidates: SectionSchema[] = [];

    if (hasBelongsToSection(node)) {
      const belongs = (node.data as Data & {
        belongsToSection: Record<string, SectionSchema>;
      }).belongsToSection;
      for (const s of Object.values(belongs)) {
        if (!sectionNamespaceFilter || sectionNamespaceFilter(s.namespace)) {
          candidates.push(s);
        }
      }
    } else if (hasSectionSchema(node)) {
      const catalog = (node.data as Data & {
        sectionSchema: Record<string, SectionSchema>;
      }).sectionSchema;
      for (const s of Object.values(catalog)) {
        if (!sectionNamespaceFilter || sectionNamespaceFilter(s.namespace)) {
          candidates.push(s);
        }
      }
    }

    for (const s of candidates) {
      attachToSection(s, item);
    }
  }

  return sectionMap;
}

/**
 * Depth-first traversal over physical sections, enriched with logical
 * classifications that belong to each section.
 */
export function visitCombinedOntology<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: CombinedOntologyOptions<Baggage>,
  visitor: CombinedVisitor<Baggage>,
): void {
  const forest = buildPhysicalForest(root, {
    namespaceFilter: options.sectionNamespaceFilter,
  });

  const sectionMap = buildSectionClassificationMap(root, options);

  const computeAncestors = (section: SectionSchema): SectionSchema[] => {
    const out: SectionSchema[] = [];
    let cur: SectionSchema | undefined | null = section;
    while (cur) {
      out.push(cur);
      cur = cur.parent ?? undefined;
    }
    out.reverse();
    return out.slice(0, -1);
  };

  const walk = (
    section: SectionSchema,
    index: number,
    parent: SectionSchema | null,
  ): typeof CONTINUE | typeof EXIT => {
    const classified = sectionMap.get(section) ?? [];
    const ancestors = computeAncestors(section);
    const res = visitor({
      section,
      classified,
      ancestors,
      index: parent ? index : null,
      parent,
    });

    if (res === EXIT) return EXIT;
    if (res === SKIP) return CONTINUE;

    const children = section.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const r = walk(child, i, section);
      if (r === EXIT) return EXIT;
    }
    return CONTINUE;
  };

  const roots = forest.roots;
  for (let i = 0; i < roots.length; i++) {
    const r = walk(roots[i], i, null);
    if (r === EXIT) break;
  }
}

/* -------------------------------------------------------------------------- */
/* Re-export visit result tokens                                              */
/* -------------------------------------------------------------------------- */

export { CONTINUE, EXIT, SKIP };
