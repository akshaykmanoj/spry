// -----------------------------------------------------------------------------
// Graph Visitor (similar to unist-util-visit, but for Graph/edges)
// -----------------------------------------------------------------------------

import { Node } from "types/unist";
import { Graph, GraphEdge } from "./graph.ts";
import { Heading, Text } from "types/mdast";

export type GraphVisitTest<Relationship extends string> =
  | Relationship
  | readonly Relationship[]
  | ((rel: Relationship) => boolean);

export type GraphVisitAction = "continue" | "skip" | "exit";

export type GraphVisitor<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = (
  rel: Relationship,
  edge: Edge,
  index: number,
  edgesForRel: readonly Edge[],
  graph: Graph<Relationship, Edge>,
) => GraphVisitAction | void;

export type GraphVisitOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = {
  /**
   * Filter which relationships to visit.
   *
   * - Single relationship literal
   * - Array of relationship literals
   * - Predicate function
   */
  readonly test?: GraphVisitTest<Relationship>;

  /**
   * Optional relationship ordering:
   * - "asc"  → lexicographic ascending
   * - "desc" → lexicographic descending
   * - custom comparator
   */
  readonly relOrder?:
    | "asc"
    | "desc"
    | ((a: Relationship, b: Relationship) => number);

  /**
   * Optional edge ordering within each relationship:
   * - "none" (default) → preserve original order
   * - "from"           → sort by from-label (stringified)
   * - "to"             → sort by to-label (stringified)
   * - custom comparator
   */
  readonly edgeOrder?:
    | "none"
    | "from"
    | "to"
    | ((a: Edge, b: Edge) => number);
};

function matchesTest<Relationship extends string>(
  rel: Relationship,
  test?: GraphVisitTest<Relationship>,
): boolean {
  if (!test) return true;

  if (typeof test === "function") {
    return test(rel);
  }

  if (Array.isArray(test)) {
    return (test as readonly Relationship[]).includes(rel);
  }

  return rel === test;
}

/**
 * visitGraph
 *
 * Similar in spirit to `unist-util-visit`, but operates on a Graph:
 *
 *   - Groups edges by `rel`
 *   - Optionally filters/ordering relationships and edges
 *   - Visits each edge with access to its relationship and group
 *
 * Visitor control-flow:
 *   - return "continue" | void  → keep going
 *   - return "skip"             → skip remaining edges for this relationship
 *   - return "exit"             → stop visiting entirely
 */
export function visitGraph<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  graph: Graph<Relationship, Edge>,
  visitor: GraphVisitor<Relationship, Edge>,
  options?: GraphVisitOptions<Relationship, Edge>,
): void {
  const { edges } = graph;
  const { test, relOrder, edgeOrder = "none" } = options ?? {};

  // Group edges by relationship
  const byRel = new Map<Relationship, Edge[]>();
  for (const edge of edges) {
    if (!matchesTest(edge.rel, test)) continue;
    const list = byRel.get(edge.rel) ?? [];
    list.push(edge);
    byRel.set(edge.rel, list);
  }

  // Determine relationship iteration order
  const rels = Array.from(byRel.keys());
  if (typeof relOrder === "function") {
    rels.sort(relOrder);
  } else if (relOrder === "asc") {
    rels.sort((a, b) => a.localeCompare(b));
  } else if (relOrder === "desc") {
    rels.sort((a, b) => b.localeCompare(a));
  }

  const stringLabelOf = (node: Node): string => {
    const t = (node as { type?: string }).type;
    if (t === "heading") return headingText(node);
    return nodePlainText(node);
  };

  for (const rel of rels) {
    const relEdges = byRel.get(rel);
    if (!relEdges || relEdges.length === 0) continue;

    let edgesToVisit = relEdges as Edge[];

    // Optional edge ordering
    if (typeof edgeOrder === "function") {
      edgesToVisit = [...edgesToVisit].sort(edgeOrder);
    } else if (edgeOrder === "from") {
      edgesToVisit = [...edgesToVisit].sort((a, b) =>
        stringLabelOf(a.from).localeCompare(stringLabelOf(b.from))
      );
    } else if (edgeOrder === "to") {
      edgesToVisit = [...edgesToVisit].sort((a, b) =>
        stringLabelOf(a.to).localeCompare(stringLabelOf(b.to))
      );
    }
    // "none" preserves original order

    for (let i = 0; i < edgesToVisit.length; i++) {
      const edge = edgesToVisit[i];
      const action = visitor(rel, edge, i, edgesToVisit, graph) ?? "continue";

      if (action === "skip") {
        // Skip remaining edges of this relationship
        break;
      }
      if (action === "exit") {
        // Stop entirely
        return;
      }
    }
  }
}

// Helper: extract heading text for assertions
export function headingText(node: Node): string {
  const heading = node as Heading;
  if (heading.type !== "heading") return "";
  const parts: string[] = [];
  for (const child of heading.children ?? []) {
    const textNode = child as Text;
    if (textNode.type === "text" && typeof textNode.value === "string") {
      parts.push(textNode.value);
      break;
    }
  }
  return parts.join("");
}

// Helper: flatten visible text from a node (ignores formatting)
export function nodePlainText(node: Node): string {
  if (node.type === "root") return "root";

  const parts: string[] = [];

  function walk(n: Node) {
    if (
      (n as { value?: unknown }).value &&
      (n as { type?: string }).type === "text"
    ) {
      // deno-lint-ignore no-explicit-any
      parts.push(String((n as any).value));
    }
    const anyN = n as { children?: Node[] };
    if (Array.isArray(anyN.children)) {
      for (const c of anyN.children) walk(c);
    }
  }

  walk(node);
  return parts.join("");
}

// -----------------------------------------------------------------------------
// Hierarchical visitors
// -----------------------------------------------------------------------------

export type HierVisitAction = "continue" | "skip" | "exit";

export type HierVisitor<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> = (
  node: Node,
  ancestors: readonly Node[],
  ctx: {
    graph: Graph<Relationship, Edge>;
    outgoing: readonly Edge[];
    incoming: readonly Edge[];
  },
) => HierVisitAction | void;

export type HierRelTest<Relationship extends string> =
  | Relationship
  | readonly Relationship[]
  | ((rel: Relationship) => boolean);

export interface VisitHierOptions<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
> {
  /**
   * Which relationships define the hierarchy?
   * e.g. "containedInHeading", "containedInSection", or a predicate.
   */
  readonly relTest?: HierRelTest<Relationship>;

  /**
   * Direction of hierarchical interpretation:
   *
   * - "childToParent" (default):
   *     edge.from = child, edge.to = parent
   *     children(node) = nodes that have edges → node
   *
   * - "parentToChild":
   *     edge.from = parent, edge.to = child
   *     children(node) = nodes that node has edges → them
   */
  readonly direction?: "childToParent" | "parentToChild";

  /**
   * Optional explicit roots. If omitted, roots are inferred from edges:
   * parents that are never children (for the selected rels).
   */
  readonly roots?: readonly Node[];

  /**
   * Optional override: custom rule for children of a node.
   *
   * If provided, this is used instead of edge-based child derivation.
   */
  readonly childrenOf?: (
    node: Node,
    ctx: {
      graph: Graph<Relationship, Edge>;
      outgoing: readonly Edge[];
      incoming: readonly Edge[];
    },
  ) => readonly Node[];
}

function matchesHierRel<Relationship extends string>(
  rel: Relationship,
  test?: HierRelTest<Relationship>,
): boolean {
  if (!test) return true;

  if (typeof test === "function") {
    return test(rel);
  }

  if (Array.isArray(test)) {
    return (test as readonly Relationship[]).includes(rel);
  }

  return rel === test;
}

export function visitHier<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
>(
  graph: Graph<Relationship, Edge>,
  visitor: HierVisitor<Relationship, Edge>,
  options?: VisitHierOptions<Relationship, Edge>,
): void {
  const { edges } = graph;
  const {
    relTest,
    direction = "childToParent",
    roots: explicitRoots,
    childrenOf,
  } = options ?? {};

  // Filter edges that participate in the hierarchy.
  const hierEdges: Edge[] = [];
  for (const e of edges) {
    if (matchesHierRel(e.rel, relTest)) {
      hierEdges.push(e);
    }
  }

  // Build incoming/outgoing maps for selected hierarchical edges.
  const outgoingByNode = new Map<Node, Edge[]>();
  const incomingByNode = new Map<Node, Edge[]>();

  const parentSet = new Set<Node>();
  const childSet = new Set<Node>();

  for (const e of hierEdges) {
    const parent = direction === "childToParent" ? e.to : e.from;
    const child = direction === "childToParent" ? e.from : e.to;

    parentSet.add(parent);
    childSet.add(child);

    // Outgoing edges: from parent to children.
    {
      const list = outgoingByNode.get(parent) ?? [];
      list.push(e);
      outgoingByNode.set(parent, list);
    }

    // Incoming edges: to child from parents.
    {
      const list = incomingByNode.get(child) ?? [];
      list.push(e);
      incomingByNode.set(child, list);
    }

    // Ensure nodes appear even if they only have one side populated.
    if (!outgoingByNode.has(child)) outgoingByNode.set(child, []);
    if (!incomingByNode.has(parent)) incomingByNode.set(parent, []);
  }

  // Determine root nodes.
  let roots: Node[];
  if (explicitRoots && explicitRoots.length > 0) {
    roots = [...explicitRoots];
  } else {
    const inferredRoots: Node[] = [];
    for (const parent of parentSet) {
      if (!childSet.has(parent)) {
        inferredRoots.push(parent);
      }
    }
    // Fallback: if no roots detected, use graph.root as a single root.
    roots = inferredRoots.length > 0 ? inferredRoots : [graph.root];
  }

  // DFS traversal with ancestors tracking.
  const ancestors: Node[] = [];
  const visited = new Set<Node>();

  const walk = (node: Node): boolean => {
    if (visited.has(node)) {
      // Avoid cycles in badly-formed graphs.
      return true;
    }
    visited.add(node);

    const outgoing = outgoingByNode.get(node) ?? [];
    const incoming = incomingByNode.get(node) ?? [];

    const action = visitor(node, ancestors, { graph, outgoing, incoming }) ??
      "continue";

    if (action === "exit") return false;
    if (action === "skip") return true;

    ancestors.push(node);

    const childNodes: readonly Node[] = childrenOf
      ? childrenOf(node, { graph, outgoing, incoming })
      : outgoing.map((e) => direction === "childToParent" ? e.from : e.to);

    for (const child of childNodes) {
      const keepGoing = walk(child);
      if (!keepGoing) {
        ancestors.pop();
        return false;
      }
    }

    ancestors.pop();
    return true;
  };

  for (const root of roots) {
    const keepGoing = walk(root);
    if (!keepGoing) break;
  }
}
