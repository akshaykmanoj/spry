/**
 * contribute-specs-resolver.ts
 *
 * Thin wrapper around `resourceContributions()` for ```contribute blocks.
 *
 * ```contribute <target> [PI flags...]
 * <candidate> [<destPrefix>] [flags...]
 * ...
 * ```
 *
 * Block PI flags:
 * - --base / -B         => fromBase
 * - --dest              => destPrefix
 * - --labeled           => labeled
 * - --interpolate / -I  => interpolate spec body before parsing
 *
 * This plugin:
 * - parses fence PI + interpolates block body (optional)
 * - attaches `contributables()` to the Code node, returning the contributions factory
 */
import z from "@zod/zod";
import type { Code, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

import { safeInterpolate } from "../../universal/flexible-interpolator.ts";
import {
  flexibleTextSchema,
  InstructionsResult,
  mergeFlexibleText,
  queryPosixPI,
} from "../../universal/posix-pi.ts";
import {
  resourceContributions,
} from "../../universal/resource-contributions.ts";

import { assert } from "@std/assert/assert";
import {
  type CodeFrontmatter,
  codeFrontmatter,
} from "../mdast/code-frontmatter.ts";
import { addIssue } from "../mdast/node-issues.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "./code-directive-candidates.ts";

export const contributePiFlagsSchema = z.object({
  base: flexibleTextSchema.optional(),
  dest: z.string().optional(),
  labeled: z.boolean().optional(),
  interpolate: z.boolean().optional(),

  // shortcuts
  /* base */ B: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => ({
  base: mergeFlexibleText(raw.base, raw.B),
  dest: raw.dest,
  labeled: raw.labeled,
  interpolate: raw.I ?? raw.interpolate,
}));

export type ContributePiFlags = z.infer<typeof contributePiFlagsSchema>;

export type ContributeSpec = Code & {
  identity?: string;
  contributeFM: CodeFrontmatter;
  contributeQPI: ReturnType<typeof queryPosixPI<ContributePiFlags>>;
  contributeSF: ReturnType<
    ReturnType<typeof queryPosixPI<ContributePiFlags>>["safeFlags"]
  >;
  contributables: (opts?: {
    resolveBasePath?: (path: string) => string;
    allowUrls?: boolean;
    /** Default destPrefix for lines that omit it. */
    destPrefix?: string;
    /** Enable labeled grammar in the spec body. */
    labeled?: boolean;
    /** Optional line transform before parsing spec body. */
    transform?: (line: string, lineNum: number) => string | false;
  }) => ReturnType<typeof resourceContributions>;
};

export function isContributeSpec(code: Code): code is ContributeSpec {
  const c = code as unknown as Partial<ContributeSpec>;
  return !!(
    c &&
    typeof c === "object" &&
    typeof c.contributables === "function" &&
    !!c.contributeFM &&
    !!c.contributeQPI &&
    !!c.contributeSF
  );
}

export interface ContributeOptions {
  readonly isSpecBlock?: (node: Code) => boolean;
  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;
}

export const contributeKeyword = "contribute" as const;

function defaultIsSpecBlock(code: Code) {
  return code.lang === contributeKeyword;
}

function contributeSpecs(
  code: Code,
  contributeFM: CodeFrontmatter,
  interpolationCtx?: Record<string, unknown>,
) {
  const contributeQPI = queryPosixPI<ContributePiFlags>(
    contributeFM.pi,
    undefined,
    { zodSchema: contributePiFlagsSchema },
  );

  // Default base to "." if not provided.
  if (!contributeQPI.hasFlag("base", "B")) contributeFM.pi.flags["base"] = ".";

  const contributeSF = contributeQPI.safeFlags();
  if (!contributeSF.success) {
    addIssue(code, {
      severity: "error",
      message:
        `Error reading contribute flags (line ${code.position?.start.line}):\n${
          z.prettifyError(contributeSF.error)
        }`,
      error: contributeSF.error,
    });
  }

  let specsSrc = code.value;
  if (contributeSF.success && contributeSF.data.interpolate) {
    specsSrc = safeInterpolate(specsSrc, {
      code,
      contributeFM,
      ...interpolationCtx,
    });
  }

  return {
    contributeFM,
    contributeQPI,
    contributeSF,
    specsSrc,
  };
}

export const resolveContributeSpecs: Plugin<[ContributeOptions?], Root> = (
  options,
) => {
  const isSpecBlock = options?.isSpecBlock ?? defaultIsSpecBlock;
  const interpolationCtx = options?.interpolationCtx;

  return (tree, vfile) => {
    visit(tree, "code", (code: Code) => {
      if (!isSpecBlock(code)) return;
      if (isContributeSpec(code)) return;

      const iCtx = interpolationCtx?.(tree, vfile);

      const contributeFM = codeFrontmatter(code, {
        cacheableInCodeNodeData: false,
        transform: iCtx
          ? ((lang, meta) => {
            if (meta) meta = safeInterpolate(meta, { code, ...iCtx });
            return { lang: lang ?? undefined, meta: meta ?? undefined };
          })
          : undefined,
      });

      if (!contributeFM) return;

      const target = contributeFM.pi.pos[0];
      if (!target) {
        addIssue(code, {
          severity: "error",
          message:
            "Contribute spec block is missing a target identity (expected ```contribute <target>).",
        });
        return;
      }

      const cs = contributeSpecs(code, contributeFM, iCtx);
      const directive = code as CodeDirectiveCandidate<
        string,
        typeof contributeKeyword
      >;
      directive.isCodeDirectiveCandidate = true;
      directive.directive = contributeKeyword;
      directive.identity = target;
      directive.instructions = contributeFM as unknown as InstructionsResult;
      assert(isCodeDirectiveCandidate(directive));

      const node = code as ContributeSpec;
      node.identity = target; // same as above, it's the same instance
      node.contributeFM = cs.contributeFM;
      node.contributeQPI = cs.contributeQPI;
      node.contributeSF = cs.contributeSF;

      node.contributables = (opts) => {
        if (!cs.contributeSF.success) {
          addIssue(node, {
            message:
              `Invalid codeFM ${node.lang} ${node.meta} (line ${node.position?.start.line})`,
            severity: "error",
            error: cs.contributeSF.error,
          });
          return [] as unknown as ReturnType<
            ContributeSpec["contributables"]
          >;
        }

        return resourceContributions(cs.specsSrc, {
          labeled: opts?.labeled ?? cs.contributeSF.data.labeled ?? false,
          fromBase: cs.contributeSF.data.base,
          destPrefix: opts?.destPrefix ?? cs.contributeSF.data.dest,
          allowUrls: opts?.allowUrls ?? false,
          resolveBasePath: opts?.resolveBasePath,
          transform: opts?.transform,
        });
      };
    });
  };
};

export default resolveContributeSpecs;
