import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";

import { shebang } from "./pmd-shebang.ts";

const ENV_VAR = "SPRY_PMD_ENTRYPOINT";

Deno.test("pmd-shebang factory behavior", async (t) => {
  const originalEnv = Deno.env.get(ENV_VAR);

  // Helper to restore env between subtests
  function resetEnv(value: string | undefined | null) {
    if (value === null || value === undefined) {
      Deno.env.delete(ENV_VAR);
    } else {
      Deno.env.set(ENV_VAR, value);
    }
  }

  await t.step("uses remote env var as-is in shebang", async () => {
    resetEnv("https://example.com/entry/pm-bootstrap.ts");

    const s = shebang();
    const line = await s.line();

    assertStringIncludes(
      line,
      "https://example.com/entry/pm-bootstrap.ts",
    );
    assertMatch(line, /^#!\/usr\/bin\/env -S deno run /);
  });

  await t.step(
    "uses local env var as cwd-relative path by default",
    async () => {
      // No actual file needed; realPath will likely fail and we fall back to abs.
      resetEnv("lib/axiom/txt-ui/pm-bootstrap.ts");

      const s = shebang();
      const line = await s.line();

      // Should not contain http/https, and should contain our relative path segment.
      assertStringIncludes(line, "lib/axiom/txt-ui/pm-bootstrap.ts");
      assertMatch(line, /^#!\/usr\/bin\/env -S deno run /);
    },
  );

  await t.step(
    "falls back to defaultEntrypoint using resolver (file URL)",
    async () => {
      resetEnv(null);

      // Pretend the resolver maps "./pm-bootstrap.ts" to a file URL.
      const fakeFileUrl = "file:///virtual/project/pm-bootstrap.ts";

      const s = shebang({
        defaultEntrypoint: "./pm-bootstrap.ts",
        resolver: () => fakeFileUrl,
      });

      const line = await s.line();

      // It should eventually use a path that includes "pm-bootstrap.ts"
      // and not treat it as a remote URL.
      assertStringIncludes(line, "pm-bootstrap.ts");
      // Just a sanity check: shouldn't be using http/https here.
      if (line.includes("http://") || line.includes("https://")) {
        throw new Error(
          "Expected local file behavior, found remote URL in shebang",
        );
      }
    },
  );

  await t.step(
    "falls back to defaultEntrypoint using resolver (remote URL)",
    async () => {
      resetEnv(null);

      const remote = "https://example.com/default/pm-bootstrap.ts";

      const s = shebang({
        defaultEntrypoint: "./pm-bootstrap.ts",
        resolver: () => remote,
      });

      const line = await s.line();
      assertStringIncludes(line, remote);
    },
  );

  await t.step(
    "emit() inserts and replaces shebang in markdown file",
    async () => {
      resetEnv("lib/axiom/txt-ui/pm-bootstrap.ts");

      const s = shebang();
      const expectedShebang = await s.line();

      const tmpDir = await Deno.makeTempDir();
      const filePath = path.join(tmpDir, "notebook.md");

      // Case 1: file has no shebang -> shebang is inserted at top.
      const originalBody = [
        "---",
        "title: Test Notebook",
        "---",
        "",
        "# Hello",
        "",
        "Some content.",
        "",
      ].join("\n");

      await Deno.writeTextFile(filePath, originalBody);

      await s.emit(filePath);

      const afterInsert = await Deno.readTextFile(filePath);
      const [firstLine, ...restLines] = afterInsert.split("\n");

      assertEquals(firstLine, expectedShebang);
      assertEquals(restLines.join("\n"), originalBody);

      // Case 2: file already has a (wrong) shebang -> it gets replaced.
      const wrongShebang =
        "#!/usr/bin/env -S deno run --allow-all old-entrypoint.ts";
      const withWrongShebang = [wrongShebang, originalBody].join("\n");

      await Deno.writeTextFile(filePath, withWrongShebang);
      await s.emit(filePath);

      const afterReplace = await Deno.readTextFile(filePath);
      const [firstLine2, ...restLines2] = afterReplace.split("\n");

      assertEquals(firstLine2, expectedShebang);
      // Body should be unchanged compared to when we *inserted* over the original.
      assertEquals(restLines2.join("\n"), originalBody);
    },
  );

  // Restore original env at the end of all subtests
  resetEnv(originalEnv ?? null);
});
