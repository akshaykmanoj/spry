/**
 * @module resource-contributions
 *
 * Parse a plain-text “contribution spec” into a stream of resolved resource contributions,
 * suitable for ingestion/materialization pipelines that need:
 * - consistent destination paths (destPrefix + relative path)
 * - provenance metadata per contribution (line number, raw spec line, parsed instruction record)
 * - a resource access strategy decision (local filesystem vs remote URL, plus related hints)
 *
 * This module is intentionally “two-stage”:
 * 1) `origins()` yields validated spec lines (including parsed args) and records any issues.
 * 2) `prepared()` expands each origin across one or more bases, runs `strategyDecisions(...)`,
 *    and yields concrete contribution objects with computed `destPath`.
 *
 * Spec grammar
 * - Unlabeled (default): `<candidate> [<destPrefix>] ...`
 * - Labeled (when `args.labeled` is true): `<label> <candidate> [<destPrefix>] ...`
 *
 * Each line is processed through:
 * - optional `transform(line, lineNum)` hook; return `false` to skip the line
 * - `instructionsFromText(...)` and `queryPosixPI(...)` so flags like `--base=...` can be read
 *
 * Base resolution
 * - `args.fromBase` defines default bases for the entire block (string or string[]).
 * - A line may override bases using `--base <value>` flags (read via Posix PI parsing).
 * - `args.resolveBasePath(base)` may rewrite base strings (e.g., normalize, map aliases).
 *
 * Destination prefix
 * - A contribution must have a destination prefix.
 * - It is taken from the line’s optional `[<destPrefix>]` argument when provided, otherwise
 *   from `args.destPrefix`. If neither is present, an error issue is recorded and that line
 *   yields no contributions.
 *
 * URL handling
 * - If a candidate parses as HTTP/HTTPS and `args.allowUrls` is not true, an error issue is
 *   recorded and the line is skipped.
 * - For URL candidates, `prepared()` uses the first effective base only (bases[0]) when
 *   constructing the strategy decision input.
 * - When a remote URL is selected, `destPath` is computed using `relativeUrlAsFsPath(...)`
 *   to create a deterministic, filesystem-safe relative path from the URL.
 *
 * Issues reporting
 * - This module does not throw on bad lines by default; it accumulates `issues[]` entries with
 *   severity and line context. Callers should inspect `issues` after iteration.
 *
 * Generic typing
 * - `resourceContributions(...)` is generic over the parsed line “shape” and the resulting
 *   contribution type.
 * - Use `args.toContribution(...)` to enrich/extend the emitted contribution objects while
 *   preserving type information.
 *
 * Primary exports
 * - `resourceContributions(text, args)`:
 *   returns `{ blockBases, issues, origins, prepared }`.
 * - `relativeUrlAsFsPath(base, url)`:
 *   converts a URL into a stable filesystem-relative path segment for destination mapping.
 */
import { join, normalize, relative } from "@std/path";
import z from "@zod/zod";
import {
  instructionsFromText,
  type InstructionsResult,
  type PosixPIQuery,
  queryPosixPI,
} from "./posix-pi.ts";
import {
  detectMimeFromPath,
  provenanceResource,
  Resource,
  ResourceLabel,
  ResourcePath,
  ResourceProvenance,
  type ResourceStrategy,
  strategyDecisions,
  tryParseHttpUrl,
} from "./resource.ts";

/** See existing file for full docs/types; unchanged unless shown below. */
export type FlexibleContributionsFlags = {
  readonly labeled?: boolean;
  readonly interpolate?: boolean;
  readonly base?: unknown;
};

export type ContributeSpecLineParsed<Shape> = z.ZodSafeParseResult<Shape>;

export type ContributeSpecLine<Shape = unknown> = {
  readonly lineNumInRawInstructions: number;
  readonly rawInstructions: string;
  readonly ir: InstructionsResult;
  readonly ppiq: PosixPIQuery;
  readonly label?: string;
  readonly candidate: string;
  readonly restArgs: readonly string[];
  readonly parsedArgs?: ContributeSpecLineParsed<Shape>;
};

export type FromTextOptions<Shape = unknown> = FlexibleContributionsFlags & {
  readonly transform?: (line: string, lineNum: number) => string | false;
  readonly schema?: (
    line: Omit<ContributeSpecLine<unknown>, "parsedArgs">,
  ) => z.ZodType<Shape> | false;
};

function* textContributions<Shape = unknown>(
  text: string,
  opts?: FromTextOptions<Shape>,
): Generator<ContributeSpecLine<Shape>> {
  const labeled = !!opts?.labeled;
  const lines = text.split(/\r\n|\r|\n/);
  let lineNum = 0;

  const effectiveLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;

  for (const raw of effectiveLines) {
    lineNum++;

    const transformed = opts?.transform ? opts.transform(raw, lineNum) : raw;
    if (transformed === false) continue;

    const trimmed = transformed.trim();
    if (!trimmed) continue;

    const ir = instructionsFromText(trimmed);
    const ppiq = queryPosixPI(ir.pi);

    const args = [...ir.pi.args];
    const required = labeled ? 2 : 1;
    if (args.length < required) continue;

    const label = labeled ? args.shift() : undefined;
    const candidate = args.shift() ?? "";
    const restArgs = args;

    const baseLine: Omit<ContributeSpecLine<unknown>, "parsedArgs"> = {
      lineNumInRawInstructions: lineNum,
      rawInstructions: trimmed,
      ir,
      ppiq,
      ...(label !== undefined ? { label } : null),
      candidate,
      restArgs,
    };

    const schema = opts?.schema ? opts.schema(baseLine) : false;
    if (schema) {
      const schemaInput = {
        ...baseLine,
        restArgs: [...restArgs],
      };
      const parsedArgs = schema.safeParse(schemaInput);

      yield {
        ...(baseLine as unknown as Omit<
          ContributeSpecLine<Shape>,
          "parsedArgs"
        >),
        parsedArgs: parsedArgs as ContributeSpecLineParsed<Shape>,
      } satisfies ContributeSpecLine<Shape>;
    } else {
      yield baseLine as unknown as ContributeSpecLine<Shape>;
    }
  }
}

export type ResourceContribution<SpecLine extends ContributeSpecLine> = {
  readonly destPrefix: string;
  readonly destPath: string;
  readonly origin: SpecLine;
  readonly provenance: ResourceProvenance;
  readonly strategy: ResourceStrategy;
};

export type ResourceContributionsIssue = {
  readonly severity: "error" | "warn";
  readonly line: number;
  readonly rawInstructions: string;
  readonly message: string;
};

export type ResourceContributionsResult<
  Shape extends { destPrefix?: string },
  SpecLine extends ContributeSpecLine<Shape>,
  Contribution extends ResourceContribution<SpecLine>,
> = Readonly<{
  blockBases: readonly string[];
  issues: readonly ResourceContributionsIssue[];
  specs: () => Generator<SpecLine>;
  provenance: () => Generator<Contribution>;
  resources: () => Generator<
    Resource<
      {
        mimeType: string | undefined;
        destPath: string;
        spec: SpecLine;
        path: ResourcePath;
        label?: ResourceLabel;
      },
      ResourceStrategy
    >,
    void,
    unknown
  >;
}>;

type LabeledShape<
  Labeled extends boolean,
  Base extends { destPrefix?: string },
> = Labeled extends true ? (Base & { label: string }) : Base;

function resourceContributionsSchema<
  Shape extends { destPrefix?: string },
>(
  labeled: boolean,
): z.ZodType<Shape> {
  // We only parse what's present on the line. destPrefix may be omitted.
  // Rest args: [destPrefix? ...]
  const base = z.object({
    restArgs: z.array(z.string()),
    label: labeled ? z.string().min(1) : z.string().min(1).optional(),
  });

  return base.transform((raw) => {
    const out: Record<string, unknown> = {};
    const destPrefix = raw.restArgs[0];
    if (destPrefix !== undefined) out.destPrefix = destPrefix;
    if (raw.label !== undefined) out.label = raw.label;
    return out as Shape;
  });
}

export function resourceContributions<
  const Labeled extends boolean = false,
  Shape extends LabeledShape<Labeled, { destPrefix?: string }> = LabeledShape<
    Labeled,
    { destPrefix?: string }
  >,
  SpecLine extends ContributeSpecLine<Shape> = ContributeSpecLine<Shape>,
  Contribution extends ResourceContribution<SpecLine> = ResourceContribution<
    SpecLine
  >,
>(
  text: string,
  args?: {
    /** Enable labeled grammar: `<label> <candidate> [<destPrefix>] ...` */
    readonly labeled?: Labeled;

    /**
     * One or more base paths/URLs that candidates are resolved against.
     * Renamed from `base` to `fromBase`.
     */
    readonly fromBase?: string | string[];

    /**
     * Default destination prefix applied when a line omits `<destPrefix>`.
     * If a line provides `<destPrefix>`, it wins.
     */
    readonly destPrefix?: string;

    /** Whether HTTP/HTTPS URL candidates are allowed. Default false. */
    readonly allowUrls?: boolean;

    /** Optional mapper to transform base strings before use. */
    readonly resolveBasePath?: (path: string) => string;

    /** Optional pre-parse line transform. Return false to skip a line. */
    readonly transform?: (line: string, lineNum: number) => string | false;

    /** Optional hook to enrich contribution outputs while preserving generic typing. */
    readonly toContribution?: (base: {
      destPrefix: string;
      destPath: string;
      origin: SpecLine;
      provenance: ResourceProvenance;
      strategy: ResourceStrategy;
    }) => Contribution;
  },
): ResourceContributionsResult<Shape, SpecLine, Contribution> {
  const blockBases = Array.isArray(args?.fromBase)
    ? args.fromBase
    : (typeof args?.fromBase === "string" && args.fromBase.length > 0
      ? [args.fromBase]
      : ["." as const]);

  const labeled = !!args?.labeled;
  const issues: ResourceContributionsIssue[] = [];

  const schema = resourceContributionsSchema<Shape>(labeled);

  const specLines = textContributions<Shape>(text, {
    labeled,
    transform: args?.transform,
    schema: () => schema,
  });

  function* specs(): Generator<SpecLine> {
    for (const line of specLines) {
      if (!line.parsedArgs) continue;

      if (!line.parsedArgs.success) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message: labeled
            ? `Invalid spec line (expected "<label> <candidate> [<destPrefix>] ..."), skipping.`
            : `Invalid spec line (expected "<candidate> [<destPrefix>] ..."), skipping.`,
        });
        continue;
      }

      // URL gate (do it here so prepared() can assume allowed)
      if (tryParseHttpUrl(line.candidate) && !args?.allowUrls) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message: "URL candidate is present but allowUrls is false, skipping.",
        });
        continue;
      }

      yield line as unknown as SpecLine;
    }
  }

  function* provenance(): Generator<Contribution> {
    const inputs = Array.from(specs()).flatMap((line) => {
      const parsed = line.parsedArgs!;
      const lineDestPrefix = parsed.success
        ? parsed.data.destPrefix
        : undefined;
      const effectiveDestPrefix = lineDestPrefix ?? args?.destPrefix;

      if (!effectiveDestPrefix || effectiveDestPrefix.length === 0) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message:
            `Missing destPrefix: provide "<destPrefix>" on the line or pass args.destPrefix.`,
        });
        return [];
      }

      const specBases = line.ppiq.getTextFlagValues("base");
      let bases = specBases.length > 0 ? specBases : blockBases;
      if (args?.resolveBasePath) {
        bases = bases.map((b) => args.resolveBasePath!(b));
      }

      const candidatePath = line.candidate;
      const mime = detectMimeFromPath(candidatePath);

      if (tryParseHttpUrl(candidatePath)) {
        const base = bases[0] ?? "";
        return [{
          base,
          path: candidatePath,
          ...(mime ? { mimeType: mime } : null),
          __line: line,
          __destPrefix: effectiveDestPrefix,
        }] as const;
      }

      return bases.map((base) => ({
        base,
        path: join(base, candidatePath),
        ...(mime ? { mimeType: mime } : null),
        __line: line,
        __destPrefix: effectiveDestPrefix,
      }));
    });

    for (
      const sd of strategyDecisions(
        inputs as unknown as Iterable<
          & { base: string; path: string; mimeType?: string }
          & Record<string, unknown>
        >,
      )
    ) {
      const p = sd.provenance as typeof inputs[number];

      const strategy = sd.strategy;

      const rel = strategy.target === "local-fs"
        ? relative(p.base, p.path)
        : relativeUrlAsFsPath(
          p.base,
          strategy.url?.toString() ?? String(p.path),
        );

      const destPath = normalize(join(p.__destPrefix as string, rel))
        .replace(/\\/g, "/");

      const baseOut = {
        destPrefix: p.__destPrefix as string,
        destPath,
        origin: p.__line as SpecLine,
        provenance: sd.provenance,
        strategy,
      };

      // deno-lint-ignore no-explicit-any
      const pMutate = p as any;
      delete pMutate["__destPrefix"];
      delete pMutate["__line"];

      yield args?.toContribution
        ? args.toContribution(baseOut)
        : (baseOut as unknown as Contribution);
    }
  }

  function* resources() {
    for (const p of provenance()) {
      const { ppiq } = p.origin;
      yield provenanceResource({
        provenance: {
          ...p.provenance,
          mimeType: ppiq.getTextFlag("mime") ?? p.provenance.mimeType,
          destPath: p.destPath,
          spec: p.origin,
        },
        strategy: p.strategy,
      });
    }
  }

  return { blockBases, issues, specs, provenance, resources } as const;
}

/**
 * Convert a URL (or URL-like input) into a deterministic filesystem-relative path.
 */
export function relativeUrlAsFsPath(base: string, url: string): string {
  try {
    const from = new URL(url, base);
    const baseUrl = new URL(base, base);

    if (from.origin !== baseUrl.origin) {
      return normalize(
        from.hostname +
          from.pathname.replace(/^\/+/, "").replace(/[:?&#]/g, "_"),
      );
    }

    let rel = from.pathname.startsWith(baseUrl.pathname)
      ? from.pathname.slice(baseUrl.pathname.length)
      : from.pathname;

    if (from.search) rel += from.search.replace(/[?&#]/g, "_");
    if (from.hash) rel += from.hash.replace(/[?&#]/g, "_");

    return normalize(rel.replace(/^\/+/, ""));
  } catch {
    const path = url.startsWith(base)
      ? url.slice(base.length).replace(/^\/+/, "")
      : url;
    return normalize(join(".", path));
  }
}
