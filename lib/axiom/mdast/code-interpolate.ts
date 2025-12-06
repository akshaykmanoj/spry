import { globToRegExp, isGlob, normalize } from "@std/path";
import z from "@zod/zod";
import { Code } from "types/mdast";
import {
  safeInterpolateAsync,
  SafeInterpolationFunctionRegistry,
  SafeInterpolationOptions,
} from "../../universal/flexible-interpolator.ts";
import { gitignore } from "../../universal/gitignore.ts";
import {
  flexibleTextSchema,
  instructionsFromText,
  mergeFlexibleText,
} from "../../universal/posix-pi.ts";
import {
  Content,
  InjectionProvider,
  Interpolator,
  Memory,
} from "../../universal/render.ts";
import { ensureTrailingNewline } from "../../universal/text-utils.ts";
import { safeJsonStringify } from "../../universal/tmpl-literal-aide.ts";
import { unsafeJsExpr } from "../../universal/unsafe-js-expr.ts";
import { build as zodSchemaFromUserAgent } from "../../universal/zod-aide.ts";
import {
  Executable,
  isMaterializable,
  Materializable,
} from "../projection/playbook.ts";
import {
  ActionableCodePiFlags,
  CaptureSpec,
} from "../remark/actionable-code-candidates.ts";
import { codeFrontmatter } from "./code-frontmatter.ts";

export const partialTmplPiFlagsSchema = z.object({
  descr: z.string().optional(),
  inject: flexibleTextSchema.optional(),
  prepend: z.boolean().optional(),
  append: z.boolean().optional(),
}).transform((raw) => {
  const inject = mergeFlexibleText(raw.inject);
  let regExes: RegExp[] = [];
  let injectAll: boolean = false;
  if (inject.length == 1 && (inject[0] == "**/*" || inject[0] == "*")) {
    injectAll = true;
  } else {
    regExes = inject.map((glob) => {
      if (!isGlob(glob)) {
        const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${exact}$`);
      }
      return globToRegExp(glob, {
        extended: true,
        globstar: true,
        caseInsensitive: false,
      });
    });
  }
  return {
    description: raw.descr,
    inject: inject.length > 0 ? inject : false as const,
    injectAll,
    regExes: inject.length > 0 ? regExes : false as const,
    prepend: raw.prepend ?? false,
    append: raw.append ?? false,
  };
});

export type PartialTmplPiFlags = z.infer<typeof partialTmplPiFlagsSchema>;

export const PARTIAL = "PARTIAL" as const;
export type PARTIAL = typeof PARTIAL;

export type PartialTmpl =
  & Code
  & {
    readonly directive: PARTIAL;
    readonly identity: string;
    readonly piFlags: PartialTmplPiFlags;
    readonly argsSchema?: z.ZodTypeAny;
    readonly render: (locals?: unknown) => { text: string; error?: unknown };
  }
  & Partial<InjectionProvider<Executable | Materializable>>;

export function partialTmpl(identity: string, code: Code): PartialTmpl | false {
  const codeFM = codeFrontmatter(code);
  if (!codeFM) return false;

  const argsSchema: PartialTmpl["argsSchema"] = codeFM.attrs
    ? zodSchemaFromUserAgent({
      type: "object",
      properties: codeFM.attrs,
      additionalProperties: true,
    })
    : undefined;
  const parsedPiFlags = z.safeParse(partialTmplPiFlagsSchema, codeFM.pi.flags);
  if (parsedPiFlags.success) {
    const { data: piFlags } = parsedPiFlags;
    let inject: PartialTmpl["inject"] = undefined;
    if (piFlags.injectAll || piFlags.regExes) {
      const { injectAll, regExes, append } = piFlags;
      inject = injectAll
        ? ((ctx) =>
          append ? `${ctx.body}\n${code.value}` : `${code.value}\n${ctx.body}`)
        : (ctx) => {
          if (ctx.path && regExes) {
            for (const re of regExes) {
              if (re.test(ctx.path)) {
                return append
                  ? `${ctx.body}\n${code.value}`
                  : `${code.value}\n${ctx.body}`;
              }
            }
          }
        };
    }
    const render: PartialTmpl["render"] = (locals) => {
      if (argsSchema) {
        const parsed = argsSchema.safeParse(locals);
        if (!parsed.success) {
          // deno-fmt-ignore
          const message = `partial "${identity}" arguments invalid: ${z.prettifyError(parsed.error)})`;
          return { text: message, error: new Error(message) };
        }
      }
      return { text: code.value };
    };
    return {
      ...code,
      directive: PARTIAL,
      identity,
      piFlags,
      inject,
      argsSchema,
      render,
    };
  }
  return false;
}

export type FlexibleMemoryValue = unknown;
export type FlexibleMemoryShape = Record<string, FlexibleMemoryValue>;

export type Capturable = ActionableCodePiFlags["capture"];

export type Captured = {
  readonly spec: CaptureSpec;
  readonly text: () => string;
  readonly json: <Value>() => Value;
  readonly toString: () => string; // defaults to text()
};

export type FlexibleMemory =
  & Memory<FlexibleMemoryValue, FlexibleMemoryShape, Capturable>
  & {
    readonly partials: Record<string, PartialTmpl>;
    readonly memoizedFsPaths: (Extract<CaptureSpec, { nature: "relFsPath" }> & {
      readonly captured: Captured;
    })[];
  };

export function flexibleMemory(
  partialTmplCandidates: Iterable<
    Code & { readonly directive: string; readonly identity?: string }
  >,
  memoized?: Record<string, Captured>,
): FlexibleMemory {
  const memoizedFsPaths: FlexibleMemory["memoizedFsPaths"] = [];
  const injectables = {
    all: [] as [string, PartialTmpl][],
    regExes: [] as [string, PartialTmpl][],
  };
  const partials: Record<string, PartialTmpl> = {};

  for (const ptc of partialTmplCandidates) {
    if (ptc.directive === PARTIAL && ptc.identity) {
      const partial = partialTmpl(ptc.identity, ptc);
      if (partial) {
        partials[ptc.identity] = partial;
        if (partial.piFlags.injectAll) {
          injectables.all.push([ptc.identity, partial]);
        } else if (partial.piFlags.regExes) {
          injectables.regExes.push([ptc.identity, partial]);
        }
      }
    }
  }

  const memoize: Memory<
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["memoize"] = async (rendered, captureSpecs) => {
    for (const cs of captureSpecs) {
      const cap: Captured = {
        spec: cs,
        text: () => rendered,
        json: <Value>() => JSON.parse(rendered) as Value,
        toString: () => rendered.trim(),
      };
      if (cs.nature === "relFsPath") {
        await Deno.writeTextFile(
          cs.fsPath,
          ensureTrailingNewline(cap.text()),
        );

        const { gitignore: ignore } = cs;
        if (ignore) {
          // We expect fsPath to be something like "./path/to/file".
          // For .gitignore we usually want a repo-relative path.
          const gi = cs.fsPath.slice("./".length);
          if (typeof ignore === "string") {
            await gitignore(gi, ignore);
          } else {
            await gitignore(gi);
          }
        }
        memoizedFsPaths.push({ ...cs, captured: cap });
      } else {
        if (memoized) memoized[cs.key] = cap;
      }
    }
  };

  return {
    get: (name) => partials[name],
    // the more specific (regExes ones) come first because "all" is higher precendence;
    // injectables are "wrapping" inward to outward
    injectables: () => [...injectables.regExes, ...injectables.all],
    memoize,
    partials,
    memoizedFsPaths,
  };
}

export function actionableContent(): Content<
  Executable | Materializable,
  Capturable
> {
  const identity = (code: Executable | Materializable) =>
    isMaterializable(code)
      ? code.materializableIdentity
      : code.spawnableIdentity;
  return {
    body: (code) => code.value,
    path: identity,
    isInterpolatable: (code) =>
      isMaterializable(code)
        ? code.materializationArgs.interpolate ?? false
        : code.spawnableArgs.interpolate ?? false,
    isInjectable: (_path, code) =>
      isMaterializable(code)
        ? code.materializationArgs.injectable ?? false
        : code.spawnableArgs.injectable ?? false,
    isMemoizable: (code: Executable | Materializable) =>
      isMaterializable(code)
        ? code.materializationArgs.capture
        : code.spawnableArgs.capture,
    locals: (action) => ({ identity: identity(action), action }),
  };
}

export const safeExprCodeBID = "safe" as const;
export const partialTmplCodeBID = "partial" as const;
export const unsafeCodeBID = "unsafe" as const;
export type CodeInterpBracketID =
  | typeof safeExprCodeBID
  | typeof partialTmplCodeBID
  | typeof unsafeCodeBID;

export const safeOnlyBrackets = [
  { id: safeExprCodeBID, prefix: "$", open: "{", close: "}" },
  { id: partialTmplCodeBID, open: "{{", close: "}}" },
] as const;

export const safetyFirstBrackets = [
  { id: safeExprCodeBID, prefix: "$", open: "{", close: "}" },
  { id: partialTmplCodeBID, open: "{{", close: "}}" },
  { id: unsafeCodeBID, prefix: "$!", open: "{", close: "}" },
] as const;

export const unsafeBrackets = [
  { id: unsafeCodeBID, prefix: "$", open: "{", close: "}" },
  { id: partialTmplCodeBID, open: "{{", close: "}}" },
] as const;

export function codeInterpolationStrategy(
  partialTmplCandidates: Iterable<
    Code & { readonly directive: string; readonly identity?: string }
  >,
  strategyOpts?: {
    unsafeGlobalsCtxName?: string;
    globals?: Record<string, unknown>;
    safeFunctions?: SafeInterpolationFunctionRegistry;
    memoized?: Record<string, Captured>;
    brackets?: SafeInterpolationOptions["brackets"];
  },
) {
  const memoized = strategyOpts?.memoized ?? {};
  const memory = flexibleMemory(partialTmplCandidates, memoized);
  const { unsafeGlobalsCtxName = "ctx" } = strategyOpts ?? {};

  const interpolate: Interpolator<
    Materializable | Executable,
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["interpolate"] = async (input, interpOpts) => {
    const interpolatedPartial = async (
      name: string,
      partialTmplArgs?: Record<string, unknown>,
    ) => {
      const partial = memory.partials[name];
      if (partial) {
        const rendered = partial.render(partialTmplArgs);
        if (rendered.error) return rendered.text;
        const result = await interpolate(rendered.text, {
          ...interpOpts,
          locals: { ...interpOpts.locals, ...partialTmplArgs },
        });
        return result.text;
      }
      // deno-fmt-ignore
      return `partial "${name}" not found (available: ${Object.keys(memory.partials).map(p => `'${p}'`).join(", ")})`;
    };

    return {
      text: await safeInterpolateAsync(input, {
        ...interpOpts.globals,
        ...interpOpts.locals,
        captured: memoized,
        memoized,
      }, {
        brackets: strategyOpts?.brackets ?? safetyFirstBrackets,
        functions: strategyOpts?.safeFunctions,
        onMissing: async (expr, info) => {
          switch (info.bracketID as CodeInterpBracketID) {
            case "safe":
              return `\$?{${expr}}`;
            case "partial": {
              const ir = instructionsFromText(expr);
              return interpolatedPartial(ir.pi.args[0], ir.attrs);
            }
            case "unsafe": {
              try {
                const unsafeJsExprLocals = {
                  ...interpOpts.locals,
                  safeJsonStringify,
                  captured: memoized,
                  memoized,
                  partial: interpolatedPartial, // dynamically call a partial
                };
                const fn = unsafeJsExpr(
                  expr,
                  unsafeGlobalsCtxName, // `ctx.*` allows access to the "globals" properties
                  Object.keys(unsafeJsExprLocals),
                );
                const value = await fn(interpOpts.globals, unsafeJsExprLocals);
                const result = await interpolate(
                  String(value ?? ""),
                  interpOpts,
                );
                return result.text;
              } catch (err) {
                return `$!{ERROR(unsafe): ${String(err)}}`;
              }
            }
          }
        },
      }),
    };
  };

  return {
    content: actionableContent(),
    interpolator: { interpolate },
    memory,
    globals: strategyOpts?.globals,
    captured: memoized,
    memoized,
  };
}
