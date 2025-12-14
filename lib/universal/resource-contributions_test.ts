// resource-contributions_test.ts
// Deno 2.5+ test suite for resourceContributions() with explicit cleanup.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resourceContributions } from "./resource-contributions.ts";

async function ensureFile(path: string, contents = "x") {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, contents);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resourceContributions() factory", async (t) => {
  await t.step(
    "local-fs: destPath computed from destPrefix + candidate",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a/b/c.sql"), "select 1;");
        await ensureFile(join(tmp, "x.json"), "{}");

        const src = [
          "a/b/c.sql sqlpage/templates",
          "x.json scripts",
        ].join("\n");

        const rc = resourceContributions(src, { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);

        assertEquals(got[0].destPrefix, "sqlpage/templates");
        assertEquals(got[0].destPath, "sqlpage/templates/a/b/c.sql");

        assertEquals(got[1].destPrefix, "scripts");
        assertEquals(got[1].destPath, "scripts/x.json");
      });
    },
  );

  await t.step("default destPrefix: line may omit destPrefix", async () => {
    await withTempDir(async (tmp) => {
      await ensureFile(join(tmp, "a.sql"), "a");
      await ensureFile(join(tmp, "b.sql"), "b");

      const src = [
        "a.sql",
        "b.sql out2",
      ].join("\n");

      const rc = resourceContributions(src, {
        fromBase: tmp,
        destPrefix: "out",
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 2);
      assertEquals(got[0].destPath, "out/a.sql"); // default applied
      assertEquals(got[1].destPath, "out2/b.sql"); // line overrides default
    });
  });

  await t.step(
    "missing destPrefix: issue when neither line nor args.destPrefix provide it",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql", { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
        assert(rc.issues[0].message.includes("Missing destPrefix"));
      });
    },
  );

  await t.step(
    "block-level bases: multiple bases produce multiple contributions",
    async () => {
      await withTempDir(async (tmp) => {
        const baseA = join(tmp, "baseA");
        const baseB = join(tmp, "baseB");

        await ensureFile(join(baseA, "dir/file.sql"), "a");
        await ensureFile(join(baseB, "dir/file.sql"), "b");

        const rc = resourceContributions("dir/file.sql out", {
          fromBase: [baseA, baseB],
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assertEquals(got[0].destPath, "out/dir/file.sql");
        assertEquals(got[1].destPath, "out/dir/file.sql");
      });
    },
  );

  await t.step("line-level --base overrides block bases", async () => {
    await withTempDir(async (tmp) => {
      const baseA = join(tmp, "baseA");
      const baseB = join(tmp, "baseB");
      const overrideBase = join(tmp, "overrideBase");

      await ensureFile(join(baseA, "dir/file.sql"), "a");
      await ensureFile(join(baseB, "dir/file.sql"), "b");
      await ensureFile(join(overrideBase, "dir/file.sql"), "o");

      const rc = resourceContributions(
        `dir/file.sql out --base ${overrideBase}`,
        { fromBase: [baseA, baseB] },
      );

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].destPath, "out/dir/file.sql");
    });
  });

  await t.step(
    "resolveBasePath transforms bases (block + line-level)",
    async () => {
      await withTempDir(async (tmp) => {
        const rootB = join(tmp, "ROOT/B");
        const rootX = join(tmp, "ROOT/X");

        await ensureFile(join(rootB, "dir/a.sql"), "a");
        await ensureFile(join(rootX, "dir/b.sql"), "b");

        const src = [
          "dir/a.sql out",
          "dir/b.sql out --base X",
        ].join("\n");

        const rc = resourceContributions(src, {
          fromBase: "B",
          resolveBasePath: (b) => join(tmp, "ROOT", b),
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assertEquals(got[0].destPath, "out/dir/a.sql");
        assertEquals(got[1].destPath, "out/dir/b.sql");
      });
    },
  );

  await t.step(
    "URL candidates: disallowed by default => issue + skipped",
    () => {
      const rc = resourceContributions("https://example.com/dir/a.sql out");
      const got = Array.from(rc.provenance());

      assertEquals(got.length, 0);
      assertEquals(rc.issues.length, 1);
      assertEquals(rc.issues[0].severity, "error");
      assertEquals(rc.issues[0].line, 1);
      assert(rc.issues[0].message.includes("allowUrls is false"));
    },
  );

  await t.step(
    "URL candidates: allowed when allowUrls=true => destPath computed",
    () => {
      const rc = resourceContributions("https://example.com/dir/a.sql out", {
        allowUrls: true,
        fromBase: "https://example.com/dir/",
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].destPath, "out/a.sql");
    },
  );

  await t.step("transform: can skip lines before parsing", async () => {
    await withTempDir(async (tmp) => {
      await ensureFile(join(tmp, "a.sql"), "a");
      await ensureFile(join(tmp, "b.sql"), "b");

      const src = [
        "# comment",
        "a.sql out",
        "skip.sql out",
        "b.sql out2",
      ].join("\n");

      const rc = resourceContributions(src, {
        fromBase: tmp,
        transform: (line) => {
          if (line.trim().startsWith("#")) return false;
          if (line.includes("skip.sql")) return false;
          return line;
        },
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 2);
      assertEquals(got[0].destPath, "out/a.sql");
      assertEquals(got[1].destPath, "out2/b.sql");
    });
  });

  await t.step(
    "edge: trailing newline in src does not create extra work",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql out\n", { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].destPath, "out/a.sql");
      });
    },
  );

  await t.step(
    "generics: toContribution can enrich outputs (type-safe)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql out", {
          fromBase: tmp,
          toContribution: (base) => ({
            ...base,
            kind: "rc" as const,
            raw: base.origin.rawInstructions,
          }),
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].kind, "rc");
        assertEquals(got[0].raw, "a.sql out");
        assertEquals(got[0].destPath, "out/a.sql");
      });
    },
  );

  await t.step(
    "labeled: parses label + candidate + optional destPrefix",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");
        await ensureFile(join(tmp, "b.sql"), "b");

        const src = [
          "core a.sql out",
          "aux b.sql", // uses default destPrefix
        ].join("\n");

        const rc = resourceContributions<true>(src, {
          labeled: true,
          fromBase: tmp,
          destPrefix: "DEFAULT",
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);

        assertEquals(got[0].destPath, "out/a.sql");
        assertEquals(got[0].origin.label, "core");

        assertEquals(got[1].destPath, "DEFAULT/b.sql");
        assertEquals(got[1].origin.label, "aux");
      });
    },
  );

  await t.step(
    "labeled: missing destPrefix without default => issue + skipped",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const src = "core a.sql"; // no destPrefix on line and no args.destPrefix
        const rc = resourceContributions<true>(src, {
          labeled: true,
          fromBase: tmp,
        });

        const got = Array.from(rc.provenance());

        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
        assert(rc.issues[0].message.includes("Missing destPrefix"));
      });
    },
  );
});
