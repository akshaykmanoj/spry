// data-bag_test.ts
//
// Deno unit tests for data-bag.ts.
// Uses Deno.test + subtests (t.step) and JSR std/assert.
//
// This file demonstrates usage in an mdast/unist-style tree, but the
// underlying data-bag utilities are generic and work with any object
// that exposes a `data` bag.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as z from "@zod/zod";

import type { Root } from "types/mdast";
import type { Node } from "types/unist";

import {
  type ArrayDataFactory,
  attachData,
  collectData,
  type DataBagNode,
  type DataFactory,
  deepMerge,
  defineNodeArrayData,
  defineNodeData,
  defineSafeNodeArrayData,
  defineSafeNodeData,
  ensureData,
  flexibleTextSchema,
  forEachData,
  getData,
  hasAnyData,
  isDataSupplier,
  mergeData,
  mergeFlexibleText,
  nodeArrayDataFactory,
  nodeDataFactory,
  safeNodeArrayDataFactory,
  safeNodeDataFactory,
  type VisitFn,
} from "./data-bag.ts";

/* -------------------------------------------------------------------------- */
/* Minimal structural helpers for mdast/unist-style trees                     */
/* -------------------------------------------------------------------------- */

type TestNode = Node & DataBagNode & {
  children?: TestNode[];
};

type TestRoot = Root & {
  children: TestNode[];
};

function makeRoot(children: TestNode[] = []): TestRoot {
  return { type: "root", children } as TestRoot;
}

function makeNode(type: string, children: TestNode[] = []): TestNode {
  return { type, children } as TestNode;
}

/**
 * Simple depth-first traversal compatible with data-bag VisitFn.
 * We declare it as VisitFn<unknown> so it can be passed anywhere a
 * generic VisitFn is expected.
 */
const visitTest: VisitFn<unknown> = (root, visitor) => {
  const r = root as TestRoot;

  const walk = (node: TestRoot | TestNode) => {
    visitor(node as unknown as DataBagNode);
    if ("children" in node && node.children) {
      for (const child of node.children) walk(child);
    }
  };

  walk(r);
};

/* -------------------------------------------------------------------------- */
/* Local issue helpers (no dependency on external issue.ts)                   */
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
      { error?: Error | z.ZodError } & Baggage
    >
  >(key);
}

export function nodeErrors<
  Key extends string,
  Baggage extends Record<string, unknown> = Record<string, unknown>,
>(key: Key) {
  return nodeArrayDataFactory<Key, Issue<"error", Baggage>>(key);
}

export function nodeLint<Key extends string, Baggage = unknown>(key: Key) {
  return nodeArrayDataFactory<
    Key,
    & { readonly severity: "info" | "warning"; readonly message: string }
    & Baggage
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

    const all = collectData<Info, "info", TestRoot>(tree, "info", visitTest);
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
      visitTest,
      (value, owner) => {
        ids.push(value.id);
        assert(owner.data);
      },
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

      assert(!hasAnyData(tree1, "meta", visitTest));
      assert(hasAnyData(tree2, "meta", visitTest));
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
/* nodeDataFactory (unsafe) + events + init/initOnFirstAccess                 */
/* -------------------------------------------------------------------------- */

Deno.test("nodeDataFactory (unsafe)", async (t) => {
  await t.step(
    "basic attach/get/safeGet/is/collect/forEach/hasAny with assign events",
    () => {
      interface Analysis {
        name: string;
        score: number;
      }

      const analysis: DataFactory<"analysis", Analysis> = nodeDataFactory<
        "analysis",
        Analysis
      >("analysis", {
        merge: true,
        visitFn: visitTest,
      });

      const assignEvents: unknown[] = [];
      analysis.events.on("assign", (detail) => {
        assignEvents.push(detail);
      });

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

      const all = analysis.collect(tree);
      assertEquals(all, [
        { name: "foo", score: 5 },
        { name: "bar", score: 10 },
      ]);

      const seen: string[] = [];
      analysis.forEach(tree, (v) => {
        seen.push(v.name);
      });
      seen.sort();
      assertEquals(seen, ["bar", "foo"]);

      assert(analysis.hasAny(tree));
      assertEquals(assignEvents.length, 1);
      const ev = assignEvents[0] as {
        key: "analysis";
        previous: Analysis | undefined;
        next: Analysis;
      };
      assertEquals(ev.key, "analysis");
      assertEquals(ev.previous, undefined);
      assertEquals(ev.next, { name: "foo", score: 5 });
    },
  );

  await t.step(
    "init and initOnFirstAccess invoke init exactly once and fire init-auto",
    () => {
      interface Meta {
        name: string;
        initialized: boolean;
      }

      let initCalls = 0;
      const meta = nodeDataFactory<"meta", Meta>("meta", {
        visitFn: visitTest,
        initOnFirstAccess: true,
        init(node, _factory, onFirstAccessAuto) {
          initCalls++;
          const data = ensureData(node);
          const value: Meta = {
            name: onFirstAccessAuto ? "auto" : "manual",
            initialized: true,
          };
          (data as Record<string, unknown>)["meta"] = value;
        },
      });

      const initEvents: unknown[] = [];
      const initAutoEvents: unknown[] = [];
      meta.events.on("init", (d) => {
        initEvents.push(d);
      });
      meta.events.on("init-auto", (d) => {
        initAutoEvents.push(d);
      });

      const n1 = makeNode("paragraph");

      // First access should auto-init
      const v1 = meta.get(n1);
      assert(v1);
      assertEquals(v1?.name, "auto");
      assertEquals(v1?.initialized, true);
      assertEquals(initCalls, 1);
      assertEquals(initAutoEvents.length, 1);
      assertEquals(initEvents.length, 0);

      // Second access should not auto-init again
      const v2 = meta.get(n1);
      assertEquals(v2, v1);
      assertEquals(initCalls, 1);
      assertEquals(initAutoEvents.length, 1);

      // Manual init should run with onFirstAccessAuto=false
      meta.init(n1, { onFirstAccessAuto: false });
      assertEquals(initCalls, 2);
      assertEquals(initEvents.length, 1);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* safeNodeDataFactory (Zod-backed, get vs safeGet + issues)                  */
/* -------------------------------------------------------------------------- */

Deno.test("safeNodeDataFactory (Zod-backed, get vs safeGet + issues)", async (t,) => {
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

      const analysis = safeNodeDataFactory<"analysis", Analysis>(
        "analysis",
        zAnalysis,
        {
          merge: true,
          visitFn: visitTest,

          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              error,
              attemptedValue,
            });
            return null;
          },

          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              error,
              storedValue,
            });
            return null;
          },
        },
      );

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

      const issuesFactory = nodeErrors<
        "issues",
        { attemptedValue?: unknown; storedValue?: unknown }
      >("issues");

      const analysis = safeNodeDataFactory<"analysis", Analysis>(
        "analysis",
        zAnalysis,
        {
          merge: true,
          visitFn: visitTest,

          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              attemptedValue,
            });
            return null; // do not store anything
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              storedValue,
            });
            return null; // do not provide replacement
          },
        },
      );

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
      assertEquals(issues[0].severity, "error");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* nodeArrayDataFactory (unsafe) + events + init/initOnFirstAccess            */
/* -------------------------------------------------------------------------- */

Deno.test("nodeArrayDataFactory (unsafe)", async (t) => {
  await t.step(
    "basic add/get/safeGet/is/collect/forEach/hasAny + add events",
    () => {
      const tags: ArrayDataFactory<"tags", string> = nodeArrayDataFactory<
        "tags",
        string
      >("tags", {
        visitFn: visitTest,
      });

      const addEvents: unknown[] = [];
      tags.events.on("add", (d) => {
        addEvents.push(d);
      });

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

      const all = tags.collect(tree);
      assertEquals([...all].sort(), ["a", "b", "c"]);

      const seen: string[] = [];
      tags.forEach(tree, (v) => {
        seen.push(v);
      });
      seen.sort();
      assertEquals(seen, ["a", "b", "c"]);

      assert(tags.hasAny(tree));
      assertEquals(addEvents.length, 1);
      const ev = addEvents[0] as {
        key: "tags";
        previous: readonly string[] | undefined;
        added: readonly string[];
        next: readonly string[];
      };
      assertEquals(ev.key, "tags");
      assertEquals(ev.previous, undefined);
      assertEquals([...ev.added].sort(), ["a", "b"]);
    },
  );

  await t.step(
    "initOnFirstAccess auto-inits array, then manual init fires init events",
    () => {
      let initCalls = 0;

      const tags = nodeArrayDataFactory<"tags", string>("tags", {
        visitFn: visitTest,
        initOnFirstAccess: true,
        init(node, _factory, onFirstAccessAuto) {
          initCalls++;
          const data = ensureData(node);
          const existing = (data["tags"] ?? []) as string[];
          const label = onFirstAccessAuto ? "auto" : "manual";
          (data as Record<string, unknown>)["tags"] = [...existing, label];
        },
      });

      const initEvents: unknown[] = [];
      const initAutoEvents: unknown[] = [];
      tags.events.on("init", (d) => {
        initEvents.push(d);
      });
      tags.events.on("init-auto", (d) => {
        initAutoEvents.push(d);
      });

      const n = makeNode("paragraph");

      // First access -> auto init
      const arr1 = tags.get(n);
      assertEquals(arr1, ["auto"]);
      assertEquals(initCalls, 1);
      assertEquals(initAutoEvents.length, 1);
      assertEquals(initEvents.length, 0);

      // Second access doesn't re-init
      const arr2 = tags.get(n);
      assertEquals(arr2, ["auto"]);
      assertEquals(initCalls, 1);

      // Manual init
      tags.init(n, { onFirstAccessAuto: false });
      const arr3 = tags.get(n);
      assertEquals(arr3, ["auto", "manual"]);
      assertEquals(initCalls, 2);
      assertEquals(initEvents.length, 1);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* safeNodeArrayDataFactory (Zod-backed, get vs safeGet + issues)             */
/* -------------------------------------------------------------------------- */

Deno.test("safeNodeArrayDataFactory (Zod-backed, get vs safeGet + issues)", async (t,) => {
  await t.step(
    "valid items attach and can be read; no issues recorded",
    () => {
      const zTag = z.string().min(1);

      const issuesFactory = nodeErrors("issues");

      const tags = safeNodeArrayDataFactory<"tags", string>(
        "tags",
        zTag,
        {
          merge: true,
          visitFn: visitTest,

          onAddSafeParseError: ({ error, node, attemptedItems }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              error,
              attemptedItems: [...attemptedItems],
            });
            return null;
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              error,
              storedValue,
            });
            return null;
          },
        },
      );

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

      const issuesFactory = nodeErrors<
        "issues",
        { attemptedItems?: unknown[]; storedValue?: unknown }
      >("issues");

      const tags = safeNodeArrayDataFactory<"tags", string>(
        "tags",
        zTag,
        {
          merge: true,
          visitFn: visitTest,

          onAddSafeParseError: ({ error, node, attemptedItems }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              attemptedItems: [...attemptedItems],
            });
            return null; // do not store
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              storedValue,
            });
            return null; // no replacement
          },
        },
      );

      const n1 = makeNode("paragraph");
      // "x" is invalid (too short)
      const n2 = tags.add(n1, "x");

      const raw = tags.get(n2);
      const safe = tags.safeGet(n2);
      assertEquals(raw, []); // nothing stored
      assertEquals(safe, []); // nothing stored, no replacement

      const issues = issuesFactory.get(n2);
      assert(issues.length > 0);
      assertEquals(issues[0].severity, "error");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* define* helpers (scalar + array; safe + unsafe)                            */
/* -------------------------------------------------------------------------- */

Deno.test("define* helpers wrap factories correctly", async (t) => {
  await t.step("defineNodeData and defineSafeNodeData", () => {
    interface Meta {
      title: string;
      flags?: { published?: boolean };
    }

    const metaDef = defineNodeData("meta" as const)<Meta, TestNode>({
      merge: true,
      visitFn: visitTest,
      initOnFirstAccess: true,
      init(node, _factory, auto) {
        const data = ensureData(node as DataBagNode);
        if (!data["meta"]) {
          (data as Record<string, unknown>)["meta"] = {
            title: auto ? "auto" : "manual",
          } satisfies Meta;
        }
      },
    });

    const safeMetaDef = defineSafeNodeData("safeMeta" as const)<
      Meta,
      TestNode
    >(
      z.object({
        title: z.string(),
        flags: z
          .object({ published: z.boolean().optional() })
          .optional(),
      }),
      {
        merge: true,
        visitFn: visitTest,
      },
    );

    const n = makeNode("paragraph");
    // Using unsafe def
    const m1 = metaDef.factory.get(n);
    assertEquals(m1?.title, "auto");

    // Using safe def
    const n2 = safeMetaDef.factory.attach(n, {
      title: "hello",
      flags: { published: true },
    });
    const m2 = safeMetaDef.factory.safeGet(n2);
    assertEquals(m2?.flags?.published, true);
  });

  await t.step("defineNodeArrayData and defineSafeNodeArrayData", () => {
    const tagsDef = defineNodeArrayData("tags" as const)<string, TestNode>({
      merge: true,
      visitFn: visitTest,
    });

    const safeTagsDef = defineSafeNodeArrayData("safeTags" as const)<
      string,
      TestNode
    >(
      z.string().min(1),
      {
        merge: true,
        visitFn: visitTest,
      },
    );

    const n = makeNode("paragraph");
    tagsDef.factory.add(n, "a", "b");
    safeTagsDef.factory.add(n, "alpha");

    const tags = tagsDef.factory.get(n);
    const safeTags = safeTagsDef.factory.safeGet(n);
    assertEquals([...tags].sort(), ["a", "b"]);
    assertEquals(safeTags, ["alpha"]);
  });
});

/* -------------------------------------------------------------------------- */
/* flexibleText helpers                                                       */
/* -------------------------------------------------------------------------- */

Deno.test("flexibleTextSchema and mergeFlexibleText", async (t) => {
  await t.step("flexibleTextSchema accepts string or string[]", () => {
    const s1 = flexibleTextSchema.parse("hello");
    const s2 = flexibleTextSchema.parse(["hello", "world"]);
    assertEquals(s1, "hello");
    assertEquals(s2, ["hello", "world"]);

    assertThrows(() => flexibleTextSchema.parse(123));
  });

  await t.step("mergeFlexibleText deduplicates and preserves order", () => {
    const out1 = mergeFlexibleText("a", "b");
    assertEquals(out1, ["a", "b"]);

    const out2 = mergeFlexibleText(["a", "b"], "b");
    assertEquals(out2, ["a", "b"]);

    const out3 = mergeFlexibleText(["a", "b"], ["b", "c"]);
    assertEquals(out3, ["a", "b", "c"]);

    const out4 = mergeFlexibleText(undefined, ["x"]);
    assertEquals(out4, ["x"]);
  });
});

/* -------------------------------------------------------------------------- */
/* issue helpers based on data-bag                                            */
/* -------------------------------------------------------------------------- */

Deno.test("issue helper factories (flexibleNodeIssues/nodeErrors/nodeLint)", () => {
  const issues = flexibleNodeIssues("issues");
  const errors = nodeErrors("errors");
  const lint = nodeLint("lint");

  const n = makeNode("paragraph");

  issues.add(n, {
    severity: "info",
    message: "FYI",
  });
  errors.add(n, {
    severity: "error",
    message: "Something failed",
  });
  lint.add(n, {
    severity: "warning",
    message: "Minor nit",
  });

  assertEquals(issues.get(n).length, 1);
  assertEquals(errors.get(n)[0].severity, "error");
  assertEquals(lint.get(n)[0].severity, "warning");
});
