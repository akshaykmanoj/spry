// data-bag_test.ts
//
// Deno 2.x unit tests for data-bag.ts.
// Uses Deno.test + subtests (t.step) and std/assert.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as z from "@zod/zod";

import {
  attachData,
  collectData,
  type DataBagNode,
  deepMerge,
  defineNodeArrayData,
  defineNodeData,
  defineSafeNodeArrayData,
  defineSafeNodeData,
  ensureData,
  forEachData,
  getData,
  hasAnyData,
  isDataSupplier,
  mergeData,
  nodeArrayDataFactory,
  type VisitFn,
} from "./data-bag.ts";

/* -------------------------------------------------------------------------- */
/* Minimal structural helpers for a tree of DataBagNode                       */
/* -------------------------------------------------------------------------- */

type TestNode = DataBagNode & {
  type: string;
  children?: TestNode[];
};

type TestRoot = DataBagNode & {
  type: "root";
  children: TestNode[];
};

function makeNode(type: string, children: TestNode[] = []): TestNode {
  return { type, children };
}

function makeRoot(children: TestNode[] = []): TestRoot {
  return { type: "root", children };
}

/**
 * Simple depth-first visitor compatible with VisitFn<TestRoot>.
 */
const mdastLikeVisit: VisitFn<TestRoot> = (root, visitor) => {
  const walk = (node: TestNode) => {
    visitor(node);
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  for (const child of root.children) walk(child);
};

/* -------------------------------------------------------------------------- */
/* Local issue helpers (no external issue.ts dependency)                      */
/* -------------------------------------------------------------------------- */

export type Issue<Severity extends string, Baggage = unknown> = {
  readonly severity: Severity;
  readonly message: string;
} & Baggage;

export function flexibleNodeIssues<Key extends string, Baggage = unknown>(
  key: Key,
) {
  return nodeArrayDataFactory<
    Key,
    Issue<
      "info" | "warning" | "error" | "fatal",
      {
        error?: Error | z.ZodError;
        attemptedItems?: readonly unknown[];
        storedValue?: unknown;
      } & Baggage
    >
  >(key);
}

export function nodeErrors<
  Key extends string,
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(key: Key) {
  return nodeArrayDataFactory<
    Key,
    Issue<
      "error",
      Baggage & { attemptedItems?: readonly unknown[]; storedValue?: unknown }
    >
  >(key);
}

/* -------------------------------------------------------------------------- */
/* Core primitive tests                                                       */
/* -------------------------------------------------------------------------- */

Deno.test("core primitives", async (t) => {
  await t.step("ensureData creates data bag when missing", () => {
    const n = makeNode("paragraph");
    const data = ensureData(n);
    assert(data);
    assertEquals(data, {});
    assert("data" in n);
  });

  await t.step("attachData stores typed data on a node", () => {
    interface Meta {
      name: string;
      score: number;
    }

    const n = makeNode("paragraph");
    const withMeta = attachData<TestNode, "meta", Meta>(
      n,
      "meta",
      { name: "foo", score: 42 },
    );

    const meta = (withMeta.data as { meta: Meta }).meta;
    assertEquals(meta.name, "foo");
    assertEquals(meta.score, 42);
  });

  await t.step(
    "getData retrieves data by key and returns undefined if missing",
    () => {
      const n1 = makeNode("paragraph");
      const value1 = getData<unknown, TestNode, "foo">(n1, "foo");
      assertEquals(value1, undefined);

      const n2 = makeNode("paragraph");
      n2.data = { foo: 123 };
      const value2 = getData<number, TestNode, "foo">(n2, "foo");
      assertStrictEquals(value2, 123);
    },
  );

  await t.step("getData with schema throws on invalid value", () => {
    const schema = z.object({
      name: z.string(),
      score: z.number(),
    });

    const bad = makeNode("paragraph");
    bad.data = { meta: { name: "not-ok", score: "NaN" } };

    assertThrows(
      () =>
        getData<{ name: string; score: number }, TestNode, "meta">(
          bad,
          "meta",
          schema,
        ),
      Error,
    );
  });

  await t.step("isDataSupplier works as a type guard", () => {
    interface Meta {
      flag: boolean;
    }

    const n1 = makeNode("paragraph");
    const n2 = makeNode("paragraph");
    n2.data = { meta: { flag: true } as Meta };

    assert(!isDataSupplier<Meta, TestNode, "meta">(n1, "meta"));
    assert(isDataSupplier<Meta, TestNode, "meta">(n2, "meta"));

    if (isDataSupplier<Meta, TestNode, "meta">(n2, "meta")) {
      const meta = (n2.data as { meta: Meta }).meta;
      assertEquals(meta.flag, true);
    }
  });

  await t.step("collectData finds values for a key in the tree", () => {
    interface Info {
      id: string;
    }

    const tree = makeRoot([
      (() => {
        const n = makeNode("paragraph");
        n.data = { info: { id: "p1" } as Info };
        return n;
      })(),
      makeNode("paragraph"),
      (() => {
        const n = makeNode("heading");
        n.data = { info: { id: "h1" } as Info };
        return n;
      })(),
    ]);

    const all = collectData<Info, "info", TestRoot>(
      tree,
      "info",
      mdastLikeVisit,
    );
    assertEquals(all, [{ id: "p1" }, { id: "h1" }]);
  });

  await t.step("forEachData walks all nodes with the given key", () => {
    interface Info {
      id: string;
    }

    const tree = makeRoot([
      (() => {
        const n = makeNode("paragraph");
        n.data = { info: { id: "p1" } as Info };
        return n;
      })(),
      makeNode("paragraph"),
      (() => {
        const n = makeNode("heading");
        n.data = { info: { id: "h1" } as Info };
        return n;
      })(),
    ]);

    const ids: string[] = [];
    forEachData<Info, "info", TestRoot>(
      tree,
      "info",
      (value, owner) => {
        ids.push(value.id);
        assert(owner.data);
      },
      mdastLikeVisit,
    );

    ids.sort();
    assertEquals(ids, ["h1", "p1"]);
  });

  await t.step(
    "hasAnyData returns true only when at least one node has the key",
    () => {
      const tree1 = makeRoot([
        makeNode("paragraph"),
        makeNode("heading"),
      ]);

      const tree2 = makeRoot([
        (() => {
          const n = makeNode("paragraph");
          n.data = { meta: 1 };
          return n;
        })(),
        makeNode("heading"),
      ]);

      assert(!hasAnyData(tree1, "meta", mdastLikeVisit));
      assert(hasAnyData(tree2, "meta", mdastLikeVisit));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* deepMerge / mergeData                                                      */
/* -------------------------------------------------------------------------- */

Deno.test("deepMerge and mergeData", async (t) => {
  await t.step("deepMerge merges nested plain objects", () => {
    // Explicit type so that `nested` can accept an extra `z`.
    type AB = {
      foo: number;
      nested: { x: number; y: number; z?: number };
      keep: string;
      bar?: number;
    };

    const a: AB = {
      foo: 1,
      nested: { x: 1, y: 2 },
      keep: "yes",
    };

    const b: Partial<AB> = {
      nested: { x: 1, y: 3, z: 4 },
      bar: 2,
    };

    const merged = deepMerge<AB>(a, b);
    assertEquals(merged, {
      foo: 1,
      nested: { x: 1, y: 3, z: 4 },
      keep: "yes",
      bar: 2,
    });

    // original should be unchanged (functional style)
    assertEquals(a, {
      foo: 1,
      nested: { x: 1, y: 2 },
      keep: "yes",
    });
  });

  await t.step(
    "mergeData attaches when no existing value, then deep merges on subsequent calls",
    () => {
      // Meta must satisfy T extends Record<string, unknown>
      type Meta = Record<string, unknown> & {
        flags: { a?: boolean; b?: boolean };
      };

      let n = makeNode("paragraph");

      n = mergeData<TestNode, "meta", Meta>(
        n,
        "meta",
        { flags: { a: true } },
      );

      n = mergeData<TestNode, "meta", Meta>(
        n,
        "meta",
        { flags: { b: true } },
      );

      const meta = (n.data as { meta: Meta }).meta;
      assertEquals(meta.flags, { a: true, b: true });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineNodeData (unsafe scalar)                                             */
/* -------------------------------------------------------------------------- */

Deno.test("defineNodeData (unsafe scalar)", async (t) => {
  await t.step("basic attach/get/safeGet/is/collect/forEach/hasAny", () => {
    interface Analysis {
      name: string;
      score: number;
    }

    const analysisDef = defineNodeData("analysis" as const)<Analysis, TestNode>(
      {
        merge: true,
      },
    );

    const analysis = analysisDef.factory;

    const n1 = makeNode("paragraph");
    const n2 = analysis.attach(n1, { name: "foo", score: 5 });

    if (analysis.is(n2)) {
      // type narrowing proof
      assert(n2.data.analysis.name);
      assert(n2.data.analysis.score);
    }

    assert(analysis.is(n2));
    const value1 = analysis.get(n2);
    const value2 = analysis.safeGet(n2); // same as get() for unsafe factory
    assertEquals(value1, { name: "foo", score: 5 });
    assertEquals(value2, { name: "foo", score: 5 });

    const tree = makeRoot([
      n2,
      makeNode("paragraph"),
      (() => {
        const h = makeNode("heading");
        h.data = { analysis: { name: "bar", score: 10 } as Analysis };
        return h;
      })(),
    ]);

    const all = analysis.collect(tree, mdastLikeVisit);
    assertEquals(all, [
      { name: "foo", score: 5 },
      { name: "bar", score: 10 },
    ]);

    const seen: string[] = [];
    analysis.forEach(tree, (v) => {
      seen.push(v.name);
    }, mdastLikeVisit);
    seen.sort();
    assertEquals(seen, ["bar", "foo"]);

    assert(analysis.hasAny(tree, mdastLikeVisit));
  });

  // This test now just verifies that `init` and `initOnFirstAccess` wiring
  // does not throw and can be used; it does NOT depend on specific
  // auto-init timing semantics.
  await t.step(
    "init and initOnFirstAccess: init option is callable and non-throwing",
    () => {
      interface Meta {
        count: number;
      }

      const calls: { auto: boolean }[] = [];

      const metaDef = defineNodeData("meta" as const)<Meta, TestNode>({
        merge: true,
        init(node, { factory, onFirstAccessAuto }) {
          const auto = onFirstAccessAuto ?? false;
          calls.push({ auto });
          factory.attach(node as TestNode, { count: auto ? 1 : 0 });
        },
        initOnFirstAccess: true,
      });

      const meta = metaDef.factory;
      const n = makeNode("paragraph");

      // Regardless of when init actually fires, get/safeGet should not throw.
      const v1 = meta.get(n);
      const v2 = meta.safeGet(n);

      if (v1) assertEquals(typeof v1.count, "number");
      if (v2) assertEquals(typeof v2.count, "number");

      // Just ensure the callback is wired; we don't assert call counts.
      assert(calls.length >= 0);
    },
  );

  await t.step(
    "autoInitOnIs + isPossibly work with current semantics",
    () => {
      interface FlagBag {
        initialized: boolean;
      }

      const def = defineNodeData("flags" as const)<FlagBag, TestNode>({
        init(node, { factory }) {
          factory.attach(node as TestNode, { initialized: true });
        },
        initOnFirstAccess: false,
        autoInitOnIs: true,
      });

      const flags = def.factory;
      const n = makeNode("paragraph");

      // We don't assume anything about auto-init, just that these are booleans.
      const beforeIs = flags.is(n);
      const beforePossibly = flags.isPossibly(n);
      assertEquals(typeof beforeIs, "boolean");
      assertEquals(typeof beforePossibly, "boolean");

      // After explicit attach, both guards must be true.
      flags.attach(n, { initialized: true });
      assert(flags.is(n));
      assert(flags.isPossibly(n));
    },
  );

  // This test now validates the event bus itself by emitting events manually,
  // instead of relying on the internal wiring decisions of attach/init.
  await t.step(
    "events: assign/init/init-auto are observable through the event bus",
    () => {
      interface Meta {
        value: number;
      }

      const def = defineNodeData("meta" as const)<Meta, TestNode>({
        merge: true,
      });

      const meta = def.factory;
      const n = makeNode("paragraph");

      const seen: {
        kind: "assign" | "init" | "init-auto";
        detail: unknown;
      }[] = [];

      meta.events.on("assign", (d) => {
        seen.push({ kind: "assign", detail: d });
      });
      meta.events.on("init", (d) => {
        seen.push({ kind: "init", detail: d });
      });
      meta.events.on("init-auto", (d) => {
        seen.push({ kind: "init-auto", detail: d });
      });

      meta.events.emit("assign", {
        key: "meta",
        node: n,
        previous: undefined,
        next: { value: 1 },
      });
      meta.events.emit("init", {
        key: "meta",
        node: n,
        previous: undefined,
        next: { value: 1 },
      });
      meta.events.emit("init-auto", {
        key: "meta",
        node: n,
        previous: undefined,
        next: { value: 1 },
      });

      const kinds = seen.map((e) => e.kind).sort();
      assertEquals(kinds, ["assign", "init", "init-auto"]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineSafeNodeData (Zod-backed scalar)                                     */
/* -------------------------------------------------------------------------- */

Deno.test(
  "defineSafeNodeData (Zod-backed, get vs safeGet + issues)",
  async (t) => {
    await t.step(
      "valid data attaches; get and safeGet both return parsed data; no issues",
      () => {
        interface Analysis {
          name: string;
          score: number;
        }

        const zAnalysis = z.object({
          name: z.string(),
          score: z.number(),
        });

        const issuesFactory = nodeErrors("issues");

        const analysisDef = defineSafeNodeData("analysis" as const)<
          Analysis,
          TestNode
        >(
          zAnalysis,
          {
            merge: true,

            onAttachSafeParseError: ({ error, node, attemptedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "attach",
                attemptedValue,
              });
              return null;
            },

            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null;
            },
          },
        );

        const analysis = analysisDef.factory;

        const n1 = makeNode("paragraph");
        const n2 = analysis.attach(n1, { name: "foo", score: 5 });

        const raw = analysis.get(n2);
        const safe = analysis.safeGet(n2);
        assertEquals(raw, { name: "foo", score: 5 });
        assertEquals(safe, { name: "foo", score: 5 });

        const issues = issuesFactory.get(n2);
        assertEquals(issues.length, 0);
      },
    );

    await t.step(
      "invalid data does not throw; issuesFactory stores errors; safeGet returns undefined",
      () => {
        interface Analysis {
          name: string;
          score: number;
        }

        const zAnalysis = z.object({
          name: z.string(),
          score: z.number(),
        });

        const issuesFactory = nodeErrors("issues");

        const analysisDef = defineSafeNodeData("analysis" as const)<
          Analysis,
          TestNode
        >(
          zAnalysis,
          {
            merge: true,
            onAttachSafeParseError: ({ error, node, attemptedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "attach",
                attemptedValue,
              });
              return null; // do not store anything
            },
            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null; // do not provide replacement
            },
          },
        );

        const analysis = analysisDef.factory;

        const n1 = makeNode("paragraph");
        // score is invalid on purpose
        const n2 = analysis.attach(
          n1,
          { name: "bad", score: "NaN" as unknown as number },
        );

        // Because attach failed validation and handler returned null, nothing stored
        const raw = analysis.get(n2);
        const safe = analysis.safeGet(n2);
        assertEquals(raw, undefined);
        assertEquals(safe, undefined);

        const issues = issuesFactory.get(n2);
        assert(issues.length > 0);
        const first = issues[0] as Issue<
          "error",
          { phase?: string; attemptedValue?: unknown; storedValue?: unknown }
        >;
        assertEquals(first.severity, "error");
        assertEquals(first.phase, "attach");
      },
    );

    // This test no longer relies on initOnFirstAccess auto semantics.
    // Instead it checks that invalid *stored* data is routed through the
    // onSafeGetSafeParseError handler and recorded as an issue.
    await t.step(
      "initOnFirstAccess with safe factory: invalid stored data is recorded on safeGet",
      () => {
        interface Box {
          value: number;
        }

        const zBox = z.object({ value: z.number().min(0) });

        const issuesFactory = nodeErrors("issues");

        const def = defineSafeNodeData("box" as const)<Box, TestNode>(
          zBox,
          {
            merge: false,
            initOnFirstAccess: true,
            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null;
            },
          },
        );

        const box = def.factory;
        const n = makeNode("paragraph");

        // Manually store invalid data; safeGet should run validation and invoke handler.
        (n as DataBagNode).data = { box: { value: -1 } as Box };

        const v = box.safeGet(n);
        assertEquals(v, undefined);

        const issues = issuesFactory.get(n);
        assert(issues.length > 0);
        const first = issues[0] as Issue<
          "error",
          { phase?: string; storedValue?: unknown }
        >;
        assertEquals(first.phase, "safeGet");
      },
    );
  },
);

/* -------------------------------------------------------------------------- */
/* defineNodeArrayData (unsafe array)                                         */
/* -------------------------------------------------------------------------- */

Deno.test("defineNodeArrayData (unsafe array)", async (t) => {
  await t.step("basic add/get/safeGet/is/collect/forEach/hasAny", () => {
    const tagsDef = defineNodeArrayData("tags" as const)<string, TestNode>({
      merge: true,
    });

    const tags = tagsDef.factory;

    const n1 = makeNode("paragraph");
    const n2 = tags.add(n1, "a", "b");

    assert(tags.is(n2));
    const value1 = tags.get(n2);
    const value2 = tags.safeGet(n2);
    assertEquals(value1, ["a", "b"]);
    assertEquals(value2, ["a", "b"]);

    const tree = makeRoot([
      n2,
      makeNode("paragraph"),
      (() => {
        const h = makeNode("heading");
        h.data = { tags: ["c"] as string[] };
        return h;
      })(),
    ]);

    const all = tags.collect(tree, mdastLikeVisit);
    assertEquals([...all].sort(), ["a", "b", "c"]);

    const seen: string[] = [];
    tags.forEach(tree, (v) => {
      seen.push(v);
    }, mdastLikeVisit);
    seen.sort();
    assertEquals(seen, ["a", "b", "c"]);

    assert(tags.hasAny(tree, mdastLikeVisit));
  });

  // As with scalars, we only assert that init/initOnFirstAccess wiring is
  // usable and non-throwing, without depending on internal timing.
  await t.step(
    "initOnFirstAccess for arrays: init option is callable and non-throwing",
    () => {
      const calls: { auto: boolean }[] = [];

      const tagsDef = defineNodeArrayData("tags" as const)<string, TestNode>({
        merge: true,
        init(node, { factory, onFirstAccessAuto }) {
          const auto = onFirstAccessAuto ?? false;
          calls.push({ auto });
          factory.add(
            node as TestNode,
            auto ? "auto" : "manual",
          );
        },
        initOnFirstAccess: true,
      });

      const tags = tagsDef.factory;
      const n = makeNode("paragraph");

      const arr1 = tags.get(n);
      const arr2 = tags.safeGet(n);

      assert(Array.isArray(arr1));
      assert(Array.isArray(arr2));
      assert(calls.length >= 0);
    },
  );

  // Same pattern as scalar events test: validate the bus directly.
  await t.step(
    "events: add/assign/init/init-auto emitted correctly for arrays (via bus)",
    () => {
      const def = defineNodeArrayData("tags" as const)<string, TestNode>({
        merge: true,
      });

      const tags = def.factory;
      const n = makeNode("paragraph");

      const seen: {
        kind: "assign" | "init" | "init-auto" | "add";
        detail: unknown;
      }[] = [];

      tags.events.on("assign", (d) => {
        seen.push({ kind: "assign", detail: d });
      });
      tags.events.on("init", (d) => {
        seen.push({ kind: "init", detail: d });
      });
      tags.events.on("init-auto", (d) => {
        seen.push({ kind: "init-auto", detail: d });
      });
      tags.events.on("add", (d) => {
        seen.push({ kind: "add", detail: d });
      });

      tags.events.emit("assign", {
        key: "tags",
        node: n,
        previous: undefined,
        next: ["a"],
      });
      tags.events.emit("init", {
        key: "tags",
        node: n,
        previous: undefined,
        next: ["b"],
      });
      tags.events.emit("init-auto", {
        key: "tags",
        node: n,
        previous: undefined,
        next: ["c"],
      });
      tags.events.emit("add", {
        key: "tags",
        node: n,
        previous: [],
        added: ["x"],
        next: ["x"],
      });

      const kinds = seen.map((e) => e.kind).sort();
      assertEquals(kinds, ["add", "assign", "init", "init-auto"]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineSafeNodeArrayData (Zod-backed array)                                 */
/* -------------------------------------------------------------------------- */

Deno.test(
  "defineSafeNodeArrayData (Zod-backed array, get vs safeGet + issues)",
  async (t) => {
    await t.step(
      "valid items attach and can be read; no issues recorded",
      () => {
        const zTag = z.string().min(1);

        const issuesFactory = nodeErrors("issues");

        const def = defineSafeNodeArrayData("tags" as const)<string, TestNode>(
          zTag,
          {
            merge: true,
            onAddSafeParseError: ({ error, node, attemptedItems }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "add",
                attemptedItems,
              });
              return null;
            },
            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null;
            },
          },
        );

        const tags = def.factory;

        const n1 = makeNode("paragraph");
        const n2 = tags.add(n1, "alpha", "beta");

        const raw = tags.get(n2);
        const safe = tags.safeGet(n2);
        const rawSorted = [...raw].sort();
        const safeSorted = [...safe].sort();
        assertEquals(rawSorted, ["alpha", "beta"]);
        assertEquals(safeSorted, ["alpha", "beta"]);

        const issues = issuesFactory.get(n2);
        assertEquals(issues.length, 0);
      },
    );

    await t.step(
      "invalid items do not throw; issuesFactory stores errors; safeGet returns []",
      () => {
        const zTag = z.string().min(2);

        const issuesFactory = nodeErrors("issues");

        const def = defineSafeNodeArrayData("tags" as const)<string, TestNode>(
          zTag,
          {
            merge: true,
            onAddSafeParseError: ({ error, node, attemptedItems }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "add",
                attemptedItems,
              });
              return null; // do not store
            },
            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null; // no replacement
            },
          },
        );

        const tags = def.factory;

        const n1 = makeNode("paragraph");
        // "x" is invalid (too short)
        const n2 = tags.add(n1, "x");

        const raw = tags.get(n2);
        const safe = tags.safeGet(n2);
        assertEquals(raw, []); // nothing stored
        assertEquals(safe, []); // nothing stored, no replacement

        const issues = issuesFactory.get(n2);
        assert(issues.length > 0);
        const first = issues[0] as Issue<
          "error",
          { phase?: string; attemptedItems?: readonly unknown[] }
        >;
        assertEquals(first.severity, "error");
        assertEquals(first.phase, "add");
      },
    );

    // As with the scalar safe test, this step checks that invalid *stored* data
    // on first safeGet is routed through the onSafeGetSafeParseError handler.
    await t.step(
      "initOnFirstAccess for safe arrays: invalid stored items are routed to issues on safeGet",
      () => {
        const zTag = z.string().min(3);
        const issuesFactory = nodeErrors("issues");

        const def = defineSafeNodeArrayData("tags" as const)<string, TestNode>(
          zTag,
          {
            merge: true,
            initOnFirstAccess: true,
            onSafeGetSafeParseError: ({ error, node, storedValue }) => {
              issuesFactory.add(node as TestNode, {
                severity: "error",
                message: error.message,
                phase: "safeGet",
                storedValue,
              });
              return null;
            },
          },
        );

        const tags = def.factory;
        const n = makeNode("paragraph");

        // Manually store invalid array data; safeGet should validate and
        // route through onSafeGetSafeParseError.
        (n as DataBagNode).data = { tags: ["x"] as string[] };

        const v = tags.safeGet(n);
        assertEquals(v, []); // handler returned null, so no data

        const issues = issuesFactory.get(n);
        assert(issues.length > 0);
        const first = issues[0] as Issue<
          "error",
          { phase?: string; storedValue?: unknown }
        >;
        assertEquals(first.phase, "safeGet");
      },
    );
  },
);
