// resource-contributions.ts

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
  readonly provenance: SpecLine;
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
  provenance: () => Generator<SpecLine>;
  prepared: () => Generator<Contribution>;
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
      provenance: SpecLine;
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

  function* provenance(): Generator<SpecLine> {
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

  function* prepared(): Generator<Contribution> {
    const inputs = Array.from(provenance()).flatMap((line) => {
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
        provenance: p.__line as SpecLine,
        strategy,
      };

      yield args?.toContribution
        ? args.toContribution(baseOut)
        : (baseOut as unknown as Contribution);
    }
  }

  return { blockBases, issues, provenance, prepared } as const;
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
