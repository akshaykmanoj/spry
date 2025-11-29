import { Heading, RootContent } from "types/mdast";
import { Node } from "types/unist";
import {
  GraphEdge,
  headingLikeNodeDataBag,
  headingText,
  nodePlainText,
} from "./graph.ts";

// -----------------------------------------------------------------------------
// Tree node + tree types
// -----------------------------------------------------------------------------

export type GraphEdgeTreeNode<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly node: Node;
  /**
   * The edge that connects this node to its parent in the tree (null for roots).
   */
  readonly edge: Edge | null;
  /**
   * All relationships that connect this node to its parent (i.e., from parent → this node)
   * across the edges used to build the hierarchy.
   */
  readonly rels: readonly Relationship[];
  readonly label: string;
  readonly level: number;
  readonly children: readonly GraphEdgeTreeNode<Relationship, Edge>[];
};

export type GraphEdgesTree<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  readonly rels: Relationship[];
  readonly edges: Iterable<Edge>;
  readonly roots: Iterable<GraphEdgeTreeNode<Relationship, Edge>>;
};

// -----------------------------------------------------------------------------
// Options for building the tree
// -----------------------------------------------------------------------------

export type GraphEdgesTreeOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  /**
   * Relationships to consider as hierarchical.
   *
   * - If omitted or empty, *all* relationships in edges are considered and
   *   used for the hierarchy (like the old buildHierarchyTrees with a single rel).
   *
   * - If provided and has > 0 entries, the FIRST relationship in this array
   *   is treated as the PRIMARY structural relationship. The tree shape
   *   (parent/child links) is derived only from edges with that relationship.
   *
   *   All other relationships in this array are tracked per-node (node.rels)
   *   and in tree.rels, and are available for text rendering / filtering,
   *   but they do NOT change the hierarchy.
   */
  readonly relationships?: readonly Relationship[];

  /**
   * Given an edge, return the parent/child pair for the tree,
   * or null/false to ignore this edge for hierarchy purposes.
   *
   * Defaults to:
   *   child = edge.from
   *   parent = edge.to
   *
   * i.e. the same semantics as buildHierarchyTrees.
   */
  readonly resolveHierarchy?: (
    edge: Edge,
  ) => { parent: Node; child: Node } | null | false;

  /**
   * Optionally override the level (depth) for a node.
   * defaultLevel is computed as:
   *   root: 0
   *   child: parent.level + 1
   */
  readonly nodeLevel?: (args: {
    node: Node;
    edge: Edge | null; // edge from parent → this node (null for roots)
    parent: GraphEdgeTreeNode<Relationship, Edge> | null;
    defaultLevel: number;
  }) => number;

  /**
   * Produce a label for a node in the tree.
   * Defaults to a simple best-effort label based on `node.type` (and heading text).
   */
  readonly nodeLabel?: (args: {
    node: Node;
    edge: Edge | null; // edge from parent → this node (null for roots)
    parent: GraphEdgeTreeNode<Relationship, Edge> | null;
    level: number;
  }) => string;
};

// -----------------------------------------------------------------------------
// Core: build a hierarchy from edges
// -----------------------------------------------------------------------------

export function graphEdgesTree<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  inputEdges: Iterable<Edge>,
  options: GraphEdgesTreeOptions<Relationship, Edge> = {},
): GraphEdgesTree<Relationship, Edge> {
  const {
    relationships,
    resolveHierarchy = defaultResolveHierarchy,
    // Wrap defaultNodeLabel so the param type matches the options type
    nodeLabel = (args) => defaultNodeLabel(args.node),
    nodeLevel,
  } = options;

  const edges = Array.from(inputEdges);

  const relationshipsArr = relationships ? [...relationships] : undefined;
  const primaryRel = relationshipsArr?.[0];

  const relFilter = relationshipsArr && relationshipsArr.length
    ? new Set<Relationship>(relationshipsArr)
    : undefined;

  // Track which rels actually contributed (even if not structural).
  const usedRels = new Set<Relationship>();

  type ParentInfo = { parent: Node; via: Edge };
  type ChildInfo = { child: Node; via: Edge };

  // These define the STRUCTURAL hierarchy (only primaryRel or all rels if none specified).
  const parentByNode = new Map<Node, ParentInfo>();
  const childrenByNode = new Map<Node, ChildInfo[]>();

  // Track all incoming relationships per node (not just the structural ones).
  const incomingRelsByNode = new Map<Node, Set<Relationship>>();

  for (const edge of edges) {
    // Filter by relationships if provided
    if (relFilter && !relFilter.has(edge.rel)) continue;

    const resolved = resolveHierarchy(edge);
    if (!resolved) continue;

    const { parent, child } = resolved;

    usedRels.add(edge.rel);

    // Decide whether this edge contributes to the structural hierarchy
    const isStructural = !primaryRel || edge.rel === primaryRel;

    if (isStructural) {
      parentByNode.set(child, { parent, via: edge });

      let children = childrenByNode.get(parent);
      if (!children) {
        children = [];
        childrenByNode.set(parent, children);
      }

      if (!children.some((c) => c.child === child && c.via === edge)) {
        children.push({ child, via: edge });
      }

      // Ensure child is present in the children map (even if it has no children itself).
      if (!childrenByNode.has(child)) {
        childrenByNode.set(child, []);
      }
    }

    // Record incoming relationship for this child node (for all rels, not just structural)
    let rels = incomingRelsByNode.get(child);
    if (!rels) {
      rels = new Set<Relationship>();
      incomingRelsByNode.set(child, rels);
    }
    rels.add(edge.rel);
  }

  if (childrenByNode.size === 0) {
    return {
      rels: [],
      edges,
      roots: [],
    };
  }

  // Roots: nodes that participate structurally (as parent or child) but have no parent.
  const allNodes = new Set<Node>([
    ...childrenByNode.keys(),
    ...parentByNode.keys(),
  ]);

  const roots: Node[] = [];
  for (const node of allNodes) {
    if (!parentByNode.has(node)) {
      roots.push(node);
    }
  }

  const buildTree = (
    node: Node,
    parent: GraphEdgeTreeNode<Relationship, Edge> | null,
    edgeFromParent: Edge | null,
  ): GraphEdgeTreeNode<Relationship, Edge> => {
    const defaultLevel = parent ? parent.level + 1 : 0;
    const level = nodeLevel
      ? nodeLevel({ node, edge: edgeFromParent, parent, defaultLevel })
      : defaultLevel;

    const relsSet = incomingRelsByNode.get(node);
    const rels = relsSet ? Array.from(relsSet) : [];

    const label = nodeLabel({
      node,
      edge: edgeFromParent,
      parent,
      level,
    });

    const childInfos = childrenByNode.get(node) ?? [];

    const self: GraphEdgeTreeNode<Relationship, Edge> = {
      node,
      edge: edgeFromParent,
      rels,
      label,
      level,
      children: [],
    };

    const childNodes = childInfos.map(({ child, via }) =>
      buildTree(child, self, via)
    );

    return {
      ...self,
      children: childNodes,
    };
  };

  const rootNodes = roots.map((rootNode) => buildTree(rootNode, null, null));

  return {
    rels: Array.from(usedRels),
    edges,
    roots: rootNodes,
  };
}

// -----------------------------------------------------------------------------
// Defaults for builder
// -----------------------------------------------------------------------------

function defaultResolveHierarchy<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(edge: Edge): { parent: Node; child: Node } {
  // Same semantics as buildHierarchyTrees:
  //   child --rel--> parent  (i.e. from = child, to = parent)
  return { parent: edge.to, child: edge.from };
}

function defaultNodeLabel(node: Node): string {
  const content = node as RootContent;
  if (!node.type) return "(not a node!)";

  if (content.type === "heading" || content.type === "paragraph") {
    let text: string;
    let depth: number | false = false;
    switch (content.type) {
      case "heading": {
        const heading = node as Heading;
        text = headingText(heading);
        depth = heading.depth;
        break;
      }

      case "paragraph":
        text = nodePlainText(node);
        break;
    }

    if (text) {
      const depthPart = typeof depth === "number" ? `#${depth} ` : "";
      return `${content.type}:${depthPart}${text}`;
    }
  }

  return JSON.stringify(node);
}

// -----------------------------------------------------------------------------
// Text rendering for GraphEdgesTree
// -----------------------------------------------------------------------------

export type GraphEdgesTreeTextOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  /**
   * Produce a label for a node when rendering.
   * Defaults to the label stored on the GraphEdgeTreeNode.
   *
   * `relationship` is the relationship heading currently being rendered,
   * or undefined if called in a no-rels fallback mode.
   */
  readonly label?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => string;

  /**
   * Decide whether to traverse this node's children.
   *
   * If omitted, children are always traversed (subject to shouldEmit for them).
   *
   * `ancestors` is an array from root → parent (excluding the node itself).
   * `relationship` is the current rel whose section we are rendering.
   */
  readonly shouldFollow?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => boolean;

  /**
   * Decide whether this node itself should be printed.
   *
   * If omitted, all nodes are emitted.
   *
   * `ancestors` is an array from root → parent (excluding the node itself).
   * `relationship` is the current rel whose section we are rendering.
   */
  readonly shouldEmit?: (args: {
    node: GraphEdgeTreeNode<Relationship, Edge>;
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
    relationship: Relationship | undefined;
  }) => boolean;
};

/**
 * Render a GraphEdgesTree as a multi-line string.
 *
 * When there are relationships present, the output is grouped as:
 *
 *   - <rel1>
 *     rootLabel
 *     ├─ child
 *     └─ ...
 *
 *   - <rel2>
 *     ...
 *
 * If `tree.rels` is empty, it falls back to rendering the forest once
 * without the relationship bullets.
 */
export function graphEdgesTreeText<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  tree: GraphEdgesTree<Relationship, Edge>,
  options: GraphEdgesTreeTextOptions<Relationship, Edge> = {},
): string {
  const rels = tree.rels as Relationship[];
  const roots = Array.from(tree.roots);

  const labelFn = options.label ??
    ((args: {
      node: GraphEdgeTreeNode<Relationship, Edge>;
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[];
      relationship: Relationship | undefined;
    }) => args.node.label);

  const shouldFollowOpt = options.shouldFollow;
  const shouldEmitOpt = options.shouldEmit;

  const lines: string[] = [];

  const shouldFollow = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
    relationship: Relationship | undefined,
  ): boolean =>
    shouldFollowOpt ? shouldFollowOpt({ node, ancestors, relationship }) : true;

  const shouldEmit = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
    relationship: Relationship | undefined,
  ): boolean =>
    shouldEmitOpt ? shouldEmitOpt({ node, ancestors, relationship }) : true;

  // ---------------------------------------------------------------------------
  // Helper: "no rels" fallback → render forest once, no bullets
  // ---------------------------------------------------------------------------
  if (!rels.length) {
    const rel: Relationship | undefined = undefined;

    const renderNode = (
      node: GraphEdgeTreeNode<Relationship, Edge>,
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
      prefix: string,
      isLast: boolean,
    ): void => {
      const follow = shouldFollow(node, ancestors, rel);
      const emit = shouldEmit(node, ancestors, rel);

      if (!emit && !follow) return;

      const connector = prefix ? (isLast ? "└─ " : "├─ ") : "";

      if (emit) {
        lines.push(
          `${prefix}${connector}${
            labelFn({ node, ancestors, relationship: rel })
          }`,
        );
      }

      if (!follow) return;

      const childPrefix = prefix + (isLast ? "   " : "│  ");
      const children = node.children;
      const lastIndex = children.length - 1;
      const nextAncestors = [...ancestors, node];

      children.forEach((child, index) => {
        renderNode(child, nextAncestors, childPrefix, index === lastIndex);
      });
    };

    roots.forEach((rootNode, index) => {
      const isLastRoot = index === roots.length - 1;
      renderNode(rootNode, [], "", isLastRoot);
      if (!isLastRoot) lines.push("");
    });

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // With relationships: bullet per relationship + tree under each
  // ---------------------------------------------------------------------------

  // Cache: does this node or any descendant participate in `rel`?
  const hasRelCache = new Map<
    Relationship,
    Map<GraphEdgeTreeNode<Relationship, Edge>, boolean>
  >();

  const nodeHasRel = (
    node: GraphEdgeTreeNode<Relationship, Edge>,
    rel: Relationship,
  ): boolean => {
    let cacheForRel = hasRelCache.get(rel);
    if (!cacheForRel) {
      cacheForRel = new Map();
      hasRelCache.set(rel, cacheForRel);
    }

    const cached = cacheForRel.get(node);
    if (cached !== undefined) return cached;

    // A node participates in `rel` if its incoming rels contain it,
    // or if any descendant participates.
    const own = node.rels.includes(rel);
    if (own) {
      cacheForRel.set(node, true);
      return true;
    }

    for (const child of node.children) {
      if (nodeHasRel(child, rel)) {
        cacheForRel.set(node, true);
        return true;
      }
    }

    cacheForRel.set(node, false);
    return false;
  };

  // Render a forest for a single relationship, returning only its lines (no bullet).
  const renderForestForRel = (rel: Relationship): string[] => {
    const out: string[] = [];

    const renderNode = (
      node: GraphEdgeTreeNode<Relationship, Edge>,
      ancestors: readonly GraphEdgeTreeNode<Relationship, Edge>[],
      prefix: string,
      isLast: boolean,
      hasPrintedAncestor: boolean,
    ): void => {
      if (!nodeHasRel(node, rel)) return;

      const follow = shouldFollow(node, ancestors, rel);
      const emit = shouldEmit(node, ancestors, rel);

      if (!emit && !follow) return;

      // Non-emitted nodes are "transparent": they don't change prefix,
      // but their children still inherit the current prefix.
      if (emit) {
        const connector = hasPrintedAncestor ? (isLast ? "└─ " : "├─ ") : ""; // first printed node under a root already has its line

        const linePrefix = hasPrintedAncestor ? prefix : "";
        out.push(
          `${linePrefix}${connector}${
            labelFn({
              node,
              ancestors,
              relationship: rel,
            })
          }`,
        );
      }

      if (!follow) return;

      const children = node.children.filter((child) => nodeHasRel(child, rel));
      if (!children.length) return;

      const nextAncestors = [...ancestors, node];

      const nextHasPrintedAncestor = hasPrintedAncestor || emit;

      const childPrefix = emit && nextHasPrintedAncestor
        ? prefix + (isLast ? "   " : "│  ")
        : prefix;

      const lastIndex = children.length - 1;
      children.forEach((child, index) => {
        renderNode(
          child,
          nextAncestors,
          childPrefix,
          index === lastIndex,
          nextHasPrintedAncestor,
        );
      });
    };

    roots.forEach((rootNode) => {
      if (!nodeHasRel(rootNode, rel)) return;

      const ancestors: GraphEdgeTreeNode<Relationship, Edge>[] = [];
      const emitRoot = shouldEmit(rootNode, ancestors, rel);
      const followRoot = shouldFollow(rootNode, ancestors, rel);

      if (!emitRoot && !followRoot) return;

      if (emitRoot) {
        out.push(
          labelFn({
            node: rootNode,
            ancestors,
            relationship: rel,
          }),
        );
      }

      if (followRoot) {
        const children = rootNode.children.filter((child) =>
          nodeHasRel(child, rel)
        );
        const lastIndex = children.length - 1;

        children.forEach((child, index) => {
          renderNode(
            child,
            [rootNode],
            "",
            index === lastIndex,
            /* hasPrintedAncestor */ emitRoot,
          );
        });
      }
    });

    return out;
  };

  // Bullet per relationship + indented tree under each.
  rels.forEach((rel, relIndex) => {
    const relLines = renderForestForRel(rel);
    if (!relLines.length) {
      return;
    }

    lines.push(`- ${String(rel)}`);
    for (const line of relLines) {
      lines.push(`  ${line}`);
    }

    if (relIndex < rels.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
}

export function headingsTreeText<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(tree: GraphEdgesTree<Relationship, Edge>, emitColors?: boolean) {
  return graphEdgesTreeText(tree, {
    shouldEmit: ({ node }) =>
      // deno-lint-ignore no-explicit-any
      (node.node as any).type === "heading" ||
      headingLikeNodeDataBag.is(node.node),
    // still follow through non-heading nodes to reach deeper headings
    shouldFollow: () => true,
    label: ({ node }) => {
      const base = node.label; // whatever graphEdgesTree() stored
      const level = node.level;

      if (emitColors) {
        // Example simple coloring by level with ANSI (or your own scheme)
        const colors = [
          "\x1b[1m", // bold for level 0
          "\x1b[36m", // cyan
          "\x1b[33m", // yellow
          "\x1b[32m", // green
          "\x1b[35m", // magenta
          "\x1b[34m", // blue
        ];
        const color = colors[Math.min(level, colors.length - 1)];
        const reset = "\x1b[0m";

        return `${color}${base}${reset}`;
      }

      return base;
    },
  });
}
