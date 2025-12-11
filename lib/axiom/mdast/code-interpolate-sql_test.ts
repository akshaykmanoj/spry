import { assertEquals } from "@std/assert";
import { renderer } from "../../universal/render.ts";
import { codeInterpolationStrategy } from "../mdast/code-interpolate.ts";
import {
  Materializable,
  playbooksFromFiles,
} from "../projection/playbook.ts";

const materializableIDs = [
  "index.sql",
  "api/ambulatory-glucose-profile/index.sql",
  "../sqlpage/templates/gri_component.handlebars",
] as const;
type MaterializableID = typeof materializableIDs[number];

const injectableIDs = [
  "api-head.sql",
  "handlebars.sql",
  "global-layout.sql",
] as const;

const partialIDs = [
  "global-layout.sql",
  "api-head.sql",
  "handlebars.sql",
] as const;

Deno.test(
  "SQL PARTIAL injection patterns (via playbooksFromFiles)",
  async (t) => {
    const fixtureUrl = new URL(
      "./code-interpolate_test.ts-fixture02.md",
      import.meta.url,
    );
    const pbff = await playbooksFromFiles([fixtureUrl.pathname]);
    const { directives } = pbff;

    const rs = codeInterpolationStrategy(directives, {
      approach: "safety-first",
      globals: {
        siteName: "Synthetic1",
      },
      safeFunctions: {},
    });
    const r = renderer(rs);

    await t.step("expected mdast Code nodes", () => {
      const { materializablesById } = pbff;
      assertEquals(Object.keys(materializablesById), [...materializableIDs]);
    });

    await t.step("expected directives", () => {
      assertEquals(
        directives.map((d) => `${d.lang} ${d.directive}:${d.identity}`),
        [
          "sql PARTIAL:global-layout.sql",
          "sql PARTIAL:api-head.sql",
          "sql PARTIAL:handlebars.sql",
        ],
      );

      // PATCH: Simulate the user request to exclude specific folders in global-layout.sql
      // We modify the meta of the directive before it is used by the strategy.
      const globalLayout = directives.find((d) =>
        d.directive === "PARTIAL" && d.identity === "global-layout.sql"
      );
      if (globalLayout) {
        // Original meta: "PARTIAL global-layout.sql --inject **/*"
        // We add exclusions. Note: posix-pi handles repeated flags as array.
        globalLayout.meta += " --inject !./api/** --inject !./sqlpage/**";
      }
    });

    await t.step("expected injectables from directives", async () => {
      const injectables = rs.memory.injectables?.();
      assertEquals(
        (await Array.fromAsync(injectables!)).map(([key]) => key),
        [...injectableIDs],
      );
    });

    await t.step("expected partials from directives", async () => {
      assertEquals(
        (await Array.fromAsync(Object.entries(rs.memory.partials))).map((
          [key],
        ) => key),
        [...partialIDs],
      );
    });

    const materializablesById = pbff.materializablesById as Record<
      MaterializableID,
      Materializable
    >;

    await t.step("SQL PARTIAL with global injection pattern", async () => {
      const result = await r.renderOne(materializablesById["index.sql"]);
      assertEquals(result.error, undefined);
      assertEquals(
        result.text,
        sqlPartialGlobalLayoutHeader +
        "-- @route.description \"Welcome to UI.\"\n",
      );
      assertEquals(result.mutation, "mutated");
      assertEquals(result.injectedTmpls, [
        { path: "index.sql", templateName: "global-layout.sql" },
      ]);
    });



    await t.step("SQL PARTIAL with API path injection pattern (SHOULD BE EXCLUDED)", async () => {
      // With the patch above, this file should match `**/*` but also `!./api/**`, so it should act as excluded.
      // Current implementation does not support exclusions, so this expectation mirrors the DESIRED behavior,
      // and will fail if code is not updated.
      const result = await r.renderOne(
        materializablesById["api/ambulatory-glucose-profile/index.sql"],
      );
      assertEquals(result.error, undefined);
      // Expectation: NO global layout injection
      assertEquals(
        result.text,
        "-- @route.description \"Welcome to UI.\"\n",
      );
      // It might still match matches for mutation if other things happen, but here we expect only global layout was injecting.
      // If no injection, mutation might be undefined or "mutated" if other transforms run. 
      // Based on fixture, only global layout injects. So text should be clean.
      assertEquals(result.injectedTmpls?.length ?? 0, 0, "Should have no injections");
    });

    await t.step("handlebars template with sqlpage injection", async () => {
      // Note: `./sqlpage/**` pattern does not match `../sqlpage/...` paths
      // So only global-layout.sql is injected
      const result = await r.renderOne(
        materializablesById["../sqlpage/templates/gri_component.handlebars"],
      );
      assertEquals(result.error, undefined);
      assertEquals(
        result.text,
        sqlPartialGlobalLayoutHeader +
        "<gri-chart></gri-chart>",
      );
      assertEquals(result.mutation, "mutated");
      assertEquals(result.injectedTmpls, [
        {
          path: "../sqlpage/templates/gri_component.handlebars",
          templateName: "global-layout.sql",
        },
      ]);
    });
  },
);

// SQL partial header that gets injected via `--inject **/*` pattern
const sqlPartialGlobalLayoutHeader = `-- BEGIN: PARTIAL global-layout.sql
SELECT 'shell' AS component,
       'Spry' AS title;

SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/\$?{path}.auto.json');
SET page_title  = json_extract($resource_json, '$.route.caption');
-- END: PARTIAL global-layout.sql
-- this is the \`\$?{cell.info}\` cell on line \$?{cell.startLine}
`;

