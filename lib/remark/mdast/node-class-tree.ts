// node-class-tree.ts

import type { Root } from "types/mdast";
import { CONTINUE, EXIT, SKIP, visit } from "unist-util-visit";

import {
  type Classification,
  type ClassificationNamespace,
  type ClassificationPath,
  type NodeClassMap,
  nodeClassNDF,
  type RootNode,
} from "../plugin/node/node-classify.ts";

import { pathTree, type PathTreeNode } from "../../universal/path-tree.ts";

/* -------------------------------------------------------------------------- */
/* Re-export visit result tokens                                              */
/* -------------------------------------------------------------------------- */

export { CONTINUE, EXIT, SKIP };

/* -------------------------------------------------------------------------- */
/* Payload + forest/node types                                                */
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

export type ClassificationNode<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = PathTreeNode<ClassifiedItem<Baggage>, ClassificationPath>;

/* -------------------------------------------------------------------------- */
/* Options for building the classification forest                             */
/* -------------------------------------------------------------------------- */

export interface ClassificationPathTreeOptions<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly pathDelim?: string;
  readonly synthesizeContainers?: boolean;
  readonly indexBasenames?: string[];
  readonly folderFirst?: boolean;
  readonly compare?: (
    a: ClassificationNode<Baggage>,
    b: ClassificationNode<Baggage>,
  ) => number;
  readonly forceAbsolute?: boolean;

  readonly namespaceFilter?: (ns: ClassificationNamespace) => boolean;

  /**
   * Optional global prefix before "<namespace>/<path>".
   * Example: "class" → "/class/test/unit/smoke".
   */
  readonly pathPrefix?: string;
}

/* -------------------------------------------------------------------------- */
/* Builder: from mdast root → classification forest                           */
/* -------------------------------------------------------------------------- */

export async function classificationPathTree<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  root: Root,
  options: ClassificationPathTreeOptions<Baggage> = {},
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

  const items: ClassifiedItem<Baggage>[] = [];

  visit(root, (node) => {
    if (!nodeClassNDF.is(node)) return;

    const classMap = nodeClassNDF.get(node) as
      | NodeClassMap<Baggage>
      | undefined;

    if (!classMap) return;

    for (const [namespace, classList] of Object.entries(classMap)) {
      const ns = namespace as ClassificationNamespace;
      if (namespaceFilter && !namespaceFilter(ns)) continue;

      for (const cls of classList as Classification<Baggage>[]) {
        const { path, baggage } = cls;

        const segments = [
          pathPrefix,
          ns,
          path,
        ].filter(Boolean) as string[];

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
  });

  return await pathTree<ClassifiedItem<Baggage>, ClassificationPath>(items, {
    nodePath: (i) => i.fullPath,
    pathDelim,
    synthesizeContainers,
    indexBasenames,
    folderFirst,
    compare: compare as
      | ((
        a: PathTreeNode<ClassifiedItem<Baggage>, ClassificationPath>,
        b: PathTreeNode<ClassifiedItem<Baggage>, ClassificationPath>,
      ) => number)
      | undefined,
    forceAbsolute,
  });
}

/* -------------------------------------------------------------------------- */
/* Visit-style traversal over classification forest                           */
/* -------------------------------------------------------------------------- */

export type ClassificationVisitResult =
  | void
  | typeof CONTINUE
  | typeof SKIP
  | typeof EXIT;

export type ClassificationVisitor<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
> = (
  node: ClassificationNode<Baggage>,
  index: number | null,
  parent: ClassificationNode<Baggage> | null,
) => ClassificationVisitResult;

export function visitClassificationForest<
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(
  forest: Awaited<ReturnType<typeof classificationPathTree<Baggage>>>,
  visitor: ClassificationVisitor<Baggage>,
): void {
  const walk = (
    node: ClassificationNode<Baggage>,
    index: number,
    parent: ClassificationNode<Baggage> | null,
  ): typeof CONTINUE | typeof EXIT => {
    const result = visitor(node, parent ? index : null, parent);

    if (result === EXIT) return EXIT;
    if (result === SKIP) return CONTINUE;

    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as ClassificationNode<Baggage>;
      const r = walk(child, i, node);
      if (r === EXIT) return EXIT;
    }

    return CONTINUE;
  };

  const roots = forest.roots as ClassificationNode<Baggage>[];
  for (let i = 0; i < roots.length; i++) {
    const rootNode = roots[i];
    const r = walk(rootNode, i, null);
    if (r === EXIT) break;
  }
}
