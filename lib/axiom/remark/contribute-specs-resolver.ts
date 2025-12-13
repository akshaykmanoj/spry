/**
 * contribute-specs-resolver.ts
 *
 * ```contribute <target> [PI flags...]
 * <path|glob|url> <destPrefix> [flags...]
 * ...
 * ```
 */
import { join, normalize, relative } from "@std/path";
import z from "@zod/zod";
import type { Code, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

import { safeInterpolate } from "../../universal/flexible-interpolator.ts";
import {
  flexibleTextSchema,
  instructionsFromText,
  type InstructionsResult,
  mergeFlexibleText,
  type PosixPIQuery,
  queryPosixPI,
} from "../../universal/posix-pi.ts";
import {
  detectMimeFromPath,
  type ResourceProvenance,
  type ResourceStrategy,
  strategyDecisions,
  tryParseHttpUrl,
} from "../../universal/resource.ts";

import {
  type CodeFrontmatter,
  codeFrontmatter,
} from "../mdast/code-frontmatter.ts";
import { addIssue } from "../mdast/node-issues.ts";

// Keep URL→fs-path normalization consistent with imports.
import { relativeUrlAsFsPath } from "./import-specs-resolver.ts";

export const contributePiFlagsSchema = z.object({
  base: flexibleTextSchema.optional(),
  interpolate: z.boolean().optional(),

  // shortcuts
  /* base */ B: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => {
  return {
    base: mergeFlexibleText(raw.base, raw.B),
    interpolate: raw.I ?? raw.interpolate,
  };
});

export type ContributePiFlags = z.infer<typeof contributePiFlagsSchema>;

export type ContributionSpecProvenance = ResourceProvenance & {
  readonly base: string;
  readonly target: string; // e.g. "sqlpage_files"
  readonly candidatePath: string; // raw path|glob|url from line
  readonly destPrefix: string; // logical destination root/prefix
  readonly rawInstructions: string;
  readonly ir: InstructionsResult;
  readonly ppiq: PosixPIQuery;
  readonly lineNumInRawInstructions: number;
};

export type ContributeSpec = Code & {
  identity?: string;
  contributeFM: CodeFrontmatter;
  contributeQPI: ReturnType<typeof queryPosixPI<ContributePiFlags>>;
  contributeSF: ReturnType<
    ReturnType<typeof queryPosixPI<ContributePiFlags>>["safeFlags"]
  >;
  contributeTarget: string;
  contributables: (
    opts?: { resolveBasePath?: (path: string) => string; allowUrls?: boolean },
  ) => ReturnType<typeof contributionProvenanceFromCode>;
};

export function isContributeSpec(code: Code): code is ContributeSpec {
  const c = code as unknown as Partial<ContributeSpec>;
  return !!(
    c &&
    typeof c === "object" &&
    "contributeFM" in c &&
    !!c.contributeFM &&
    "contributeQPI" in c &&
    !!c.contributeQPI &&
    "contributeSF" in c &&
    !!c.contributeSF &&
    "contributeTarget" in c &&
    typeof c.contributeTarget === "string" &&
    "contributables" in c &&
    typeof c.contributables === "function"
  );
}

export interface ContributeOptions {
  readonly isSpecBlock?: (node: Code) => boolean;

  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;
}

export function contributeSpecs(
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

  const lines = specsSrc.split(/\r\n|\r|\n/);
  return {
    contributeFM,
    contributeQPI,
    contributeSF,
    specLines: lines.at(-1) === "" ? lines.slice(0, -1) : lines,
  };
}

export function* contributionProvenanceFromCode(
  code: Code,
  cs: ReturnType<typeof contributeSpecs>,
  target: string,
  opts?: { resolveBasePath?: (path: string) => string; allowUrls?: boolean },
) {
  if (!cs || !cs.contributeSF.success) return;

  const { resolveBasePath } = opts ?? {};
  const { contributeSF, specLines } = cs;
  const codeStartLine = code.position?.start.line ?? 0;
  const { base: blockBases } = contributeSF.data;

  let lineNum = 0;
  for (const line of specLines) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const ir = instructionsFromText(trimmed);
    const ppiq = queryPosixPI(ir.pi);

    if (ir.pi.args.length < 2) {
      addIssue(code, {
        severity: "error",
        message: `Contribute spec \`${trimmed}\` on line ${
          codeStartLine + lineNum
        } is not valid (must have "<path|glob|url> <destPrefix> ..."), skipping.`,
      });
      continue;
    }

    const [candidatePath, destPrefix] = ir.pi.args;

    const common: Pick<
      ContributionSpecProvenance,
      | "rawInstructions"
      | "ir"
      | "ppiq"
      | "candidatePath"
      | "destPrefix"
      | "target"
      | "lineNumInRawInstructions"
    > = {
      rawInstructions: trimmed,
      ir,
      ppiq,
      candidatePath,
      destPrefix,
      target,
      lineNumInRawInstructions: lineNum,
    };

    const specBases = ppiq.getTextFlagValues("base");
    let bases = specBases.length > 0 ? specBases : blockBases;
    if (resolveBasePath) bases = bases.map((b) => resolveBasePath(b));

    if (tryParseHttpUrl(candidatePath)) {
      if (!opts?.allowUrls) {
        addIssue(code, {
          severity: "error",
          message: `Contribute spec \`${trimmed}\` on line ${
            codeStartLine + lineNum
          } is a URL, but URL contributions are disabled (enable allowUrls in plugin options). Skipping.`,
        });
        continue;
      }

      const mime = detectMimeFromPath(candidatePath);
      yield {
        base: bases.length > 0 ? bases[0] : "",
        path: candidatePath,
        ...(mime ? { mimeType: mime } : null),
        ...common,
      } satisfies ContributionSpecProvenance;
    } else {
      for (const base of bases) {
        const mime = detectMimeFromPath(candidatePath);
        const path = join(base, candidatePath);
        yield {
          base,
          path,
          ...(mime ? { mimeType: mime } : null),
          ...common,
        } satisfies ContributionSpecProvenance;
      }
    }
  }
}

export type PreparedContribution = {
  readonly target: string;
  readonly destPrefix: string;
  readonly destPath: string;
  readonly provenance: ContributionSpecProvenance;
  readonly strategy: ResourceStrategy;
};

export function* contributions(
  specs: ContributeSpec,
  opts?: Parameters<ContributeSpec["contributables"]>[0],
) {
  const contribs = Array.from(specs.contributables(opts));
  for (const sd of strategyDecisions(contribs)) {
    const { provenance, strategy } = sd;
    const { path, base, destPrefix, target } = provenance;

    const rel = strategy.target === "local-fs"
      ? relative(base, path)
      : relativeUrlAsFsPath(base, strategy.url?.toString() ?? path);

    const destPath = normalize(join(destPrefix, rel)).replace(/\\/g, "/");

    yield {
      target,
      destPrefix,
      destPath,
      provenance,
      strategy,
    } satisfies PreparedContribution;
  }
}

function defaultIsSpecBlock(code: Code) {
  return code.lang === "contribute";
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

      // ```contribute sqlpage_files
      const target = contributeFM.pi.pos[0];
      if (!target) {
        addIssue(code, {
          severity: "error",
          message:
            "Contribute spec block is missing a target identity in fence meta (expected ```contribute <target>).",
        });
        return;
      }

      const cs = contributeSpecs(code, contributeFM, iCtx);

      const contributeNode = code as ContributeSpec;
      contributeNode.identity = target;
      contributeNode.contributeTarget = target;

      contributeNode.contributeFM = contributeFM;
      contributeNode.contributeQPI = cs.contributeQPI;
      contributeNode.contributeSF = cs.contributeSF;

      contributeNode.contributables = (opts) =>
        contributionProvenanceFromCode(code, cs, target, opts);
    });
  };
};

export default resolveContributeSpecs;
