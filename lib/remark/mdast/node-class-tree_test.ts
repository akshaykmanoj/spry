// node-class-tree_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1.0.16";
import { CONTINUE } from "unist-util-visit";

import type { Root } from "types/mdast";

import {
  type Classification,
  type ClassificationNamespace,
  type ClassificationPath,
  type NodeClassMap,
  nodeClassNDF,
  type RootNode,
} from "../plugin/node/node-classify.ts";

import {
  type ClassificationNode,
  classificationPathTree,
  type ClassifiedItem,
  visitClassificationForest,
} from "./node-class-tree.ts";

Deno.test("node-class-tree: classification forest and visitor", async (t) => {
  // -------------------------------------------------------------------------
  // Synthetic mdast root + classified nodes
  // -------------------------------------------------------------------------

  const root: Root = {
    type: "root",
    children: [],
  } as Root;

  const para1: RootNode = {
    type: "paragraph",
    children: [],
  } as RootNode;

  const para2: RootNode = {
    type: "paragraph",
    children: [],
  } as RootNode;

  const para3: RootNode = {
    type: "paragraph",
    children: [],
  } as RootNode;

  root.children.push(para1, para2, para3);

  // Attach synthetic classifications using nodeClassNDF
  const classMap1: NodeClassMap<Record<string, unknown>> = {
    test: [
      { path: "unit/smoke", baggage: { id: "n1-smoke" } },
      { path: "unit/regression", baggage: { id: "n1-reg" } },
    ] as Classification<Record<string, unknown>>[],
  };

  const classMap2: NodeClassMap<Record<string, unknown>> = {
    test: [
      { path: "unit/smoke", baggage: { id: "n2-smoke" } },
    ] as Classification<Record<string, unknown>>[],
    doc: [
      { path: "overview", baggage: { id: "doc-overview" } },
    ] as Classification<Record<string, unknown>>[],
  };

  const classMap3: NodeClassMap<Record<string, unknown>> = {
    nav: [
      { path: "guides/getting-started", baggage: { id: "nav-gs" } },
    ] as Classification<Record<string, unknown>>[],
  };

  nodeClassNDF.attach(para1, classMap1);
  nodeClassNDF.attach(para2, classMap2);
  nodeClassNDF.attach(para3, classMap3);

  // -------------------------------------------------------------------------
  await t.step(
    "builds multi-level classification forest with namespaces",
    async () => {
      const forest = await classificationPathTree(root);

      // Expect namespace-level roots: /doc, /nav, /test
      const rootPaths = forest.roots.map((n) => n.path).sort();
      assertEquals(rootPaths, ["/doc", "/nav", "/test"]);

      // Ensure multi-level path structure exists for test/unit/smoke
      const smokePath = "/test/unit/smoke" as ClassificationPath;
      const smokeNode = forest.treeByPath.get(smokePath) as
        | ClassificationNode
        | undefined;
      assert(smokeNode, "expected node at /test/unit/smoke");

      const unitPath = "/test/unit" as ClassificationPath;
      assertEquals(
        forest.parentMap.get(smokePath),
        unitPath,
      );
      assertEquals(
        forest.parentMap.get(unitPath),
        "/test" as ClassificationPath,
      );

      // Two payloads at same path (/test/unit/smoke) from para1 + para2
      const payloads = (smokeNode.payloads ?? []) as ClassifiedItem[];
      assertEquals(payloads.length, 2);
      const baggageIds = payloads
        .map((p) => (p.baggage as { id?: string } | undefined)?.id)
        .sort();
      assertEquals(baggageIds, ["n1-smoke", "n2-smoke"]);
    },
  );

  // -------------------------------------------------------------------------
  await t.step(
    "respects pathPrefix by grouping under a shared root",
    async () => {
      const forest = await classificationPathTree(root, {
        pathPrefix: "class",
      });

      // All namespaces should be grouped under /class
      assertEquals(forest.roots.length, 1);
      const classRoot = forest.roots[0];
      assertEquals(classRoot.path, "/class");

      const nsBasenames = classRoot.children.map((c) => c.basename).sort();
      assertEquals(nsBasenames, ["doc", "nav", "test"]);
    },
  );

  // -------------------------------------------------------------------------
  await t.step("namespaceFilter restricts included namespaces", async () => {
    const forest = await classificationPathTree(root, {
      namespaceFilter: (ns: ClassificationNamespace) => ns === "test",
    });

    const rootPaths = forest.roots.map((n) => n.path);
    assertEquals(rootPaths, ["/test"]);

    // doc and nav paths should be absent
    assertEquals(
      forest.treeByPath.get("/doc" as ClassificationPath),
      undefined,
    );
    assertEquals(
      forest.treeByPath.get("/nav" as ClassificationPath),
      undefined,
    );
  });

  // -------------------------------------------------------------------------
  await t.step(
    "visitClassificationForest traverses all nodes in DFS order",
    async () => {
      const forest = await classificationPathTree(root);

      const visitedPaths: string[] = [];
      const visitedLeafPayloadIds: string[] = [];

      visitClassificationForest(forest, (node) => {
        visitedPaths.push(node.path);

        if (node.payloads && node.payloads.length > 0) {
          for (const p of node.payloads as ClassifiedItem[]) {
            const id = (p.baggage as { id?: string } | undefined)?.id;
            if (id) visitedLeafPayloadIds.push(id);
          }
        }

        return CONTINUE;
      });

      // Ensure some key paths are visited
      assert(visitedPaths.includes("/test"));
      assert(visitedPaths.includes("/doc"));
      assert(visitedPaths.includes("/nav"));
      assert(visitedPaths.includes("/test/unit/smoke"));

      // All baggage ids from classification maps should have been seen
      visitedLeafPayloadIds.sort();
      assertEquals(
        visitedLeafPayloadIds,
        [
          "doc-overview",
          "n1-reg",
          "n1-smoke",
          "n2-smoke",
          "nav-gs",
        ].sort(),
      );
    },
  );
});
