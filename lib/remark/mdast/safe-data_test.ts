// safe-data_test.ts
//
// Deno 2.5 unit tests for safe-data.ts.
// Uses Deno.test + subtests (t.step) and JSR std/assert.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as z from "@zod/zod";

import type { Root } from "types/mdast";
import type { Node } from "types/unist";

import { nodeErrors } from "./issue.ts";
import {
  type ArrayDataFactory,
  attachData,
  collectData,
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
} from "./safe-data.ts";

/* -------------------------------------------------------------------------- */
/* Minimal structural helpers for Root / Node in tests                        */
/* -------------------------------------------------------------------------- */

type TestNode = Node & {
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

    const all = collectData<Info, "info">(tree, "info");
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
    forEachData<Info, "info">(
      tree,
      "info",
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

      assert(!hasAnyData(tree1, "meta"));
      assert(hasAnyData(tree2, "meta"));
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
/* defineNodeData (unsafe DataFactory)                                        */
/* -------------------------------------------------------------------------- */

Deno.test("defineNodeData (unsafe)", async (t) => {
  await t.step("basic attach/get/safeGet/is/collect/forEach/hasAny", () => {
    interface Analysis {
      name: string;
      score: number;
    }

    const analysisDef = defineNodeData("analysis" as const)<Analysis>({
      merge: true,
    });
    const analysis: DataFactory<"analysis", Analysis> = analysisDef.factory;

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

    // collectNodes coverage
    const nodes = analysis.collectNodes<TestNode>(tree);
    assertEquals(nodes.length, 2);
    assertEquals(nodes[0].data.analysis.name, "foo");
    assertEquals(nodes[1].data.analysis.name, "bar");
  });

  await t.step(
    "init + initOnFirstAccess initialize data on first access",
    () => {
      interface Analysis {
        name: string;
        score: number;
      }

      const calls: { auto: boolean }[] = [];

      const def = defineNodeData("analysisInit" as const)<Analysis>({
        merge: true,
        initOnFirstAccess: true,
        init(node, factory, onFirstAccessAuto) {
          calls.push({ auto: !!onFirstAccessAuto });
          factory.attach(node, {
            name: onFirstAccessAuto ? "auto" : "manual",
            score: onFirstAccessAuto ? 1 : 0,
          });
        },
      });

      const analysis = def.factory;

      // Manual init
      const n1 = makeNode("paragraph");
      analysis.init(n1);
      assertEquals(calls.length, 1);
      assertEquals(calls[0], { auto: false });
      assertEquals(analysis.get(n1), { name: "manual", score: 0 });

      // Auto init on first access
      const n2 = makeNode("paragraph");
      const v2 = analysis.get(n2);
      assertEquals(calls.length, 2);
      assertEquals(calls[1], { auto: true });
      assertEquals(v2, { name: "auto", score: 1 });

      // Subsequent access should not trigger init again
      const v3 = analysis.get(n2);
      assertEquals(v3, { name: "auto", score: 1 });
      assertEquals(calls.length, 2);

      // init called when data already exists should still run (and overwrite)
      analysis.init(n2);
      assertEquals(calls.length, 3);
      assertEquals(calls[2], { auto: false });
      assertEquals(analysis.get(n2), { name: "manual", score: 0 });
    },
  );

  await t.step("initOnFirstAccess true without init is a no-op", () => {
    interface Foo {
      v: number;
    }

    const def = defineNodeData("noInitScalar" as const)<Foo>({
      initOnFirstAccess: true,
    });

    const f = def.factory;
    const n = makeNode("paragraph");

    const v1 = f.get(n);
    const v2 = f.safeGet(n);
    assertEquals(v1, undefined);
    assertEquals(v2, undefined);
  });

  await t.step(
    "initOnFirstAccess with ifNotExists prefers init result over ifNotExists",
    () => {
      interface Foo {
        v: string;
      }

      let ifNotExistsCalled = false;

      const def = defineNodeData("initVsIfNot" as const)<Foo>({
        initOnFirstAccess: true,
        init(node, factory, auto) {
          factory.attach(node, { v: auto ? "from-init-auto" : "from-init" });
        },
      });

      const f = def.factory;
      const n = makeNode("paragraph");

      const v = f.get(n, () => {
        ifNotExistsCalled = true;
        return { v: "from-ifNotExists" };
      });

      assertEquals(ifNotExistsCalled, false);
      assertEquals(v, { v: "from-init-auto" });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineSafeNodeData (Zod-backed)                                            */
/* -------------------------------------------------------------------------- */

Deno.test("defineSafeNodeData (Zod-backed, get vs safeGet + issues)", async (t) => {
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

      const analysisDef = defineSafeNodeData("analysis" as const)<Analysis>(
        zAnalysis,
        {
          merge: true,

          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "attach",
              attemptedValue,
            });
            return null;
          },

          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
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

      // collectNodes coverage
      const tree = makeRoot([n2]);
      const nodes = analysis.collectNodes<TestNode>(tree);
      assertEquals(nodes.length, 1);
      assertEquals(nodes[0].data.analysis.name, "foo");
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

      const analysisDef = defineSafeNodeData("analysisBad" as const)<Analysis>(
        zAnalysis,
        {
          merge: true,
          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "attach",
              attemptedValue,
            });
            return null; // do not store anything
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
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
      assertEquals(issues[0].severity, "error");
      assertEquals(issues[0].phase, "attach");
    },
  );

  await t.step("init + initOnFirstAccess work with Zod-backed factory", () => {
    interface Analysis {
      name: string;
      score: number;
    }

    const zAnalysis = z.object({
      name: z.string(),
      score: z.number(),
    });

    const calls: { auto: boolean }[] = [];

    const def = defineSafeNodeData("analysisInitSafe" as const)<Analysis>(
      zAnalysis,
      {
        merge: true,
        initOnFirstAccess: true,
        init(node, factory, onFirstAccessAuto) {
          calls.push({ auto: !!onFirstAccessAuto });
          factory.attach(node, {
            name: onFirstAccessAuto ? "auto" : "manual",
            score: onFirstAccessAuto ? 1 : 0,
          });
        },
      },
    );

    const analysis = def.factory;

    // Manual init
    const n1 = makeNode("paragraph");
    analysis.init(n1);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], { auto: false });
    assertEquals(analysis.safeGet(n1), { name: "manual", score: 0 });

    // Auto init on first safeGet
    const n2 = makeNode("paragraph");
    const v2 = analysis.safeGet(n2);
    assertEquals(calls.length, 2);
    assertEquals(calls[1], { auto: true });
    assertEquals(v2, { name: "auto", score: 1 });

    // Auto init on first get()
    const n3 = makeNode("paragraph");
    const v3 = analysis.get(n3);
    assertEquals(calls.length, 3);
    assertEquals(calls[2], { auto: true });
    assertEquals(v3, { name: "auto", score: 1 });

    // Subsequent safeGet should not call init again
    const v4 = analysis.safeGet(n2);
    assertEquals(v4, { name: "auto", score: 1 });
    assertEquals(calls.length, 3);
  });

  await t.step("merge behavior for safe factory with merge=true", () => {
    interface Meta {
      nested: { a?: number; b?: number };
    }

    const zMeta = z.object({
      nested: z.object({
        a: z.number().optional(),
        b: z.number().optional(),
      }),
    });

    const def = defineSafeNodeData("safeMerge" as const)<Meta>(
      zMeta,
      { merge: true },
    );

    const f = def.factory;
    const n = makeNode("paragraph");

    f.attach(n, { nested: { a: 1 } });
    f.attach(n, { nested: { b: 2 } });

    const v = f.safeGet(n);
    assertEquals(v, { nested: { a: 1, b: 2 } });
  });

  await t.step(
    "onExistingSafeParseError is called when existing raw value is invalid",
    () => {
      interface Meta {
        x: number;
      }

      const zMeta = z.object({
        x: z.number(),
      });

      let handlerCalled = false;

      const def = defineSafeNodeData("safeExisting" as const)<Meta>(
        zMeta,
        {
          merge: true,
          onExistingSafeParseError: ({ existingValue }) => {
            handlerCalled = true;
            // existingValue is invalid; replace with a valid Meta
            assertEquals(existingValue, "bad-existing");
            return { x: 1 };
          },
        },
      );

      const f = def.factory;
      const n = makeNode("paragraph");

      // Simulate an invalid existing value coming from outside
      // deno-lint-ignore no-explicit-any
      (n as any).data = { safeExisting: "bad-existing" };

      f.attach(n, { x: 2 });

      assertEquals(handlerCalled, true);
      const v = f.safeGet(n);
      // existing { x:1 } merged with { x:2 } just overwrites x
      assertEquals(v, { x: 2 });
    },
  );

  await t.step(
    "error handler that returns invalid replacement does not store value",
    () => {
      interface Foo {
        x: number;
      }

      const zFoo = z.object({
        x: z.number(),
      });

      const def = defineSafeNodeData("badHandler" as const)<Foo>(
        zFoo,
        {
          onAttachSafeParseError: () => {
            // Return invalid replacement: will fail second validation
            return { x: "still-bad" } as unknown as Foo;
          },
        },
      );

      const f = def.factory;
      const n = makeNode("paragraph");

      // deno-lint-ignore no-explicit-any
      f.attach(n, { x: "nope" } as any);

      const v = f.safeGet(n);
      assertEquals(v, undefined);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineNodeArrayData (unsafe ArrayDataFactory)                              */
/* -------------------------------------------------------------------------- */

Deno.test("defineNodeArrayData (unsafe)", async (t) => {
  await t.step("basic add/get/safeGet/is/collect/forEach/hasAny", () => {
    const tagsDef = defineNodeArrayData("tags" as const)<string>();
    const tags: ArrayDataFactory<"tags", string> = tagsDef.factory;

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

    // collectNodes coverage (one per node that has non-empty array)
    const nodes = tags.collectNodes<TestNode>(tree);
    assertEquals(nodes.length, 2);
    assertEquals(nodes[0].data.tags.length > 0, true);
    assertEquals(nodes[1].data.tags.length > 0, true);
  });

  await t.step("init + initOnFirstAccess initialize array data", () => {
    const calls: { auto: boolean }[] = [];

    const def = defineNodeArrayData("tagsInit" as const)<string>({
      initOnFirstAccess: true,
      init(node, factory, onFirstAccessAuto) {
        calls.push({ auto: !!onFirstAccessAuto });
        factory.add(node, onFirstAccessAuto ? "auto" : "manual");
      },
    });

    const tags = def.factory;

    // Manual init
    const n1 = makeNode("paragraph");
    tags.init(n1);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], { auto: false });
    assertEquals(tags.get(n1), ["manual"]);

    // Auto init on first get()
    const n2 = makeNode("paragraph");
    const arr2 = tags.get(n2);
    assertEquals(calls.length, 2);
    assertEquals(calls[1], { auto: true });
    assertEquals(arr2, ["auto"]);

    // Subsequent get should not call init again
    const arr3 = tags.get(n2);
    assertEquals(arr3, ["auto"]);
    assertEquals(calls.length, 2);

    // Manual init on node with existing data should still run
    tags.init(n2);
    assertEquals(calls.length, 3);
  });

  await t.step(
    "initOnFirstAccess true without init is a no-op for arrays",
    () => {
      const def = defineNodeArrayData("noInitArr" as const)<string>({
        initOnFirstAccess: true,
      });

      const tags = def.factory;
      const n = makeNode("paragraph");

      const v1 = tags.get(n);
      const v2 = tags.safeGet(n);
      assertEquals(v1, []);
      assertEquals(v2, []);
    },
  );

  await t.step(
    "initOnFirstAccess with ifNotExists prefers init result over ifNotExists for arrays",
    () => {
      let ifNotExistsCalled = false;

      const def = defineNodeArrayData("arrInitVsIf" as const)<string>({
        initOnFirstAccess: true,
        init(node, factory, auto) {
          factory.add(node, auto ? "from-init-auto" : "from-init");
        },
      });

      const f = def.factory;
      const n = makeNode("paragraph");

      const v = f.get(n, () => {
        ifNotExistsCalled = true;
        return ["from-ifNotExists"];
      });

      assertEquals(ifNotExistsCalled, false);
      assertEquals(v, ["from-init-auto"]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* defineSafeNodeArrayData (Zod-backed ArrayDataFactory)                      */
/* -------------------------------------------------------------------------- */

Deno.test("defineSafeNodeArrayData (Zod-backed, get vs safeGet + issues)", async (t) => {
  await t.step("valid items attach and can be read; no issues recorded", () => {
    const zTag = z.string().min(1);

    const issuesFactory = nodeErrors("issues");

    const tagsDef = defineSafeNodeArrayData("tags" as const)<string>(
      zTag,
      {
        merge: true,
        onAddSafeParseError: ({ error, node, attemptedItems }) => {
          issuesFactory.add(node, {
            severity: "error",
            message: error.message,
            phase: "add",
            attemptedItems,
          });
          return null;
        },
        onSafeGetSafeParseError: ({ error, node, storedValue }) => {
          issuesFactory.add(node, {
            severity: "error",
            message: error.message,
            phase: "safeGet",
            storedValue,
          });
          return null;
        },
      },
    );

    const tags = tagsDef.factory;

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

    // collectNodes coverage
    const tree = makeRoot([n2]);
    const nodes = tags.collectNodes<TestNode>(tree);
    assertEquals(nodes.length, 1);
    assertEquals(nodes[0].data.tags.length, 2);
  });

  await t.step(
    "invalid items do not throw; issuesFactory stores errors; safeGet returns []",
    () => {
      const zTag = z.string().min(2);

      const issuesFactory = nodeErrors("issues");

      const tagsDef = defineSafeNodeArrayData("tagsBad" as const)<string>(
        zTag,
        {
          merge: true,
          onAddSafeParseError: ({ error, node, attemptedItems }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "add",
              attemptedItems,
            });
            return null; // do not store
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "safeGet",
              storedValue,
            });
            return null; // no replacement
          },
        },
      );

      const tags = tagsDef.factory;

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
      assertEquals(issues[0].phase, "add");
    },
  );

  await t.step("init + initOnFirstAccess work with Zod-backed arrays", () => {
    const zTag = z.string().min(1);

    const calls: { auto: boolean }[] = [];

    const def = defineSafeNodeArrayData("tagsInitSafe" as const)<string>(
      zTag,
      {
        merge: true,
        initOnFirstAccess: true,
        init(node, factory, onFirstAccessAuto) {
          calls.push({ auto: !!onFirstAccessAuto });
          factory.add(node, onFirstAccessAuto ? "auto" : "manual");
        },
      },
    );

    const tags = def.factory;

    // Manual init
    const n1 = makeNode("paragraph");
    tags.init(n1);
    assertEquals(calls.length, 1);
    assertEquals(calls[0], { auto: false });
    assertEquals(tags.safeGet(n1), ["manual"]);

    // Auto init on first safeGet
    const n2 = makeNode("paragraph");
    const arr2 = tags.safeGet(n2);
    assertEquals(calls.length, 2);
    assertEquals(calls[1], { auto: true });
    assertEquals(arr2, ["auto"]);

    // Auto init on first get()
    const n3 = makeNode("paragraph");
    const arr3 = tags.get(n3);
    assertEquals(calls.length, 3);
    assertEquals(calls[2], { auto: true });
    assertEquals(arr3, ["auto"]);

    // Subsequent safeGet should not call init again
    const arr4 = tags.safeGet(n2);
    assertEquals(arr4, ["auto"]);
    assertEquals(calls.length, 3);
  });

  await t.step(
    "merge behavior for safe array factory with merge=true",
    () => {
      const zTag = z.string().min(1);

      const def = defineSafeNodeArrayData("safeArrMerge" as const)<string>(
        zTag,
        { merge: true },
      );

      const f = def.factory;
      const n = makeNode("paragraph");

      f.add(n, "a");
      f.add(n, "b", "c");

      const got = f.safeGet(n);
      const sorted = [...got].sort();
      assertEquals(sorted, ["a", "b", "c"]);
    },
  );

  await t.step(
    "onExistingSafeParseError is called when existing raw array is invalid",
    () => {
      const zTag = z.string().min(1);
      let handlerCalled = false;

      const def = defineSafeNodeArrayData("safeArrExisting" as const)<string>(
        zTag,
        {
          merge: true,
          onExistingSafeParseError: ({ existingValue }) => {
            handlerCalled = true;
            assertEquals(existingValue, "bad-array");
            return ["fixed-existing"];
          },
        },
      );

      const f = def.factory;
      const n = makeNode("paragraph");

      // deno-lint-ignore no-explicit-any
      (n as any).data = { safeArrExisting: "bad-array" };

      f.add(n, "new");

      assertEquals(handlerCalled, true);
      const got = f.safeGet(n);
      const sorted = [...got].sort();
      assertEquals(sorted, ["fixed-existing", "new"]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* flexibleTextSchema / mergeFlexibleText                                     */
/* -------------------------------------------------------------------------- */

Deno.test("flexibleTextSchema and mergeFlexibleText", async (t) => {
  await t.step("flexibleTextSchema parses string and array of strings", () => {
    const v1 = flexibleTextSchema.parse("hello");
    const v2 = flexibleTextSchema.parse(["a", "b"]);
    assertEquals(v1, "hello");
    assertEquals(v2, ["a", "b"]);
  });

  await t.step("mergeFlexibleText merges and deduplicates strings", () => {
    // both undefined
    assertEquals(mergeFlexibleText(undefined, undefined), []);

    // string + string
    assertEquals(mergeFlexibleText("a", "b"), ["a", "b"]);
    assertEquals(mergeFlexibleText("a", "a"), ["a"]);

    // string + array
    assertEquals(mergeFlexibleText("a", ["a", "b"]), ["a", "b"]);
    assertEquals(mergeFlexibleText("x", ["a", "x", "b"]), ["x", "a", "b"]);

    // array + string
    assertEquals(mergeFlexibleText(["a", "b"], "b"), ["a", "b"]);
    assertEquals(mergeFlexibleText(["a", "b"], "c"), ["a", "b", "c"]);

    // array + array
    assertEquals(
      mergeFlexibleText(["a", "b"], ["b", "c", "a"]),
      ["a", "b", "c"],
    );
  });
});
