import { globToRegExp, isGlob, normalize } from "@std/path";
import z from "@zod/zod";
import { safeInterpolateAsync } from "../../universal/flexible-interpolator.ts";
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
import { build as zodSchemaFromUserAgent } from "../../universal/zod-aide.ts";
import { Directive } from "../projection/directives.ts";
import {
  Executable,
  isMaterializable,
  Materializable,
} from "../projection/playbook.ts";
import {
  ActionableCodePiFlags,
  CaptureSpec,
} from "../remark/actionable-code-candidates.ts";

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

export type PartialTmpl =
  & Directive
  & {
    readonly piFlags: PartialTmplPiFlags;
    readonly argsSchema?: z.ZodTypeAny;
    readonly render: (locals?: unknown) => { text: string; error?: unknown };
  }
  & Partial<InjectionProvider<Executable | Materializable>>;

export function partialTmpl(d: Directive): PartialTmpl | false {
  const argsSchema: PartialTmpl["argsSchema"] = d.instructions.attrs
    ? zodSchemaFromUserAgent({
      type: "object",
      properties: d.instructions.attrs,
      additionalProperties: true,
    })
    : undefined;
  const parsedPiFlags = z.safeParse(
    partialTmplPiFlagsSchema,
    d.instructions.pi.flags,
  );
  if (parsedPiFlags.success) {
    const { data: piFlags } = parsedPiFlags;
    let inject: PartialTmpl["inject"] = undefined;
    if (piFlags.injectAll || piFlags.regExes) {
      const { injectAll, regExes, append } = piFlags;
      inject = injectAll
        ? ((ctx) =>
          append ? `${ctx.body}\n${d.value}` : `${d.value}\n${ctx.body}`)
        : (ctx) => {
          if (ctx.path && regExes) {
            for (const re of regExes) {
              if (re.test(ctx.path)) {
                return append
                  ? `${ctx.body}\n${d.value}`
                  : `${d.value}\n${ctx.body}`;
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
          const message = `partial "${name}" arguments invalid: ${z.prettifyError(parsed.error)})`;
          return { text: message, error: new Error(message) };
        }
      }
      return { text: d.value };
    };
    return { ...d, piFlags, inject, argsSchema, render };
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
};

export type FlexibleMemory =
  & Memory<FlexibleMemoryValue, FlexibleMemoryShape, Capturable>
  & { partials: Record<string, PartialTmpl> };

export function flexibleMemory(
  directives: readonly Directive[],
  captures?: Record<string, Captured>,
): FlexibleMemory {
  const injectables = {
    all: [] as [string, PartialTmpl][],
    regExes: [] as [string, PartialTmpl][],
  };
  const partials: Record<string, PartialTmpl> = {};

  for (const d of directives) {
    if (d.directive === "PARTIAL" && d.identity) {
      const partial = partialTmpl(d);
      if (partial) {
        partials[d.identity] = partial;
        if (partial.piFlags.injectAll) {
          injectables.all.push([d.identity, partial]);
        } else if (partial.piFlags.regExes) {
          injectables.regExes.push([d.identity, partial]);
        }
      }
    }
  }

  const memoize: Memory<
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["memoize"] = async (rendered, capture) => {
    for (const cs of capture) {
      const cap: Captured = {
        spec: cs,
        text: () => rendered,
        json: <Value>() => JSON.parse(rendered) as Value,
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
      } else {
        if (captures) captures[cs.key] = cap;
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
  };
}

export function actionableContent(): Content<
  Executable | Materializable,
  Capturable
> {
  return {
    body: (code) => code.value,
    path: (code) =>
      isMaterializable(code)
        ? code.materializableIdentity
        : code.spawnableIdentity,
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
  };
}

const IDENT_RX = /^[A-Za-z_$][\w$]*$/;

const assertValidIdentifier = (name: string, label = "identifier") => {
  if (!IDENT_RX.test(name)) {
    throw new Error(
      `Invalid ${label} "${name}". Use a simple JavaScript identifier.`,
    );
  }
};

function compileUnsafeExpr(
  expr: string,
  ctxName: string,
  localKeys: readonly string[],
) {
  if (localKeys.includes(ctxName)) {
    throw new Error(
      `Local key "${ctxName}" conflicts with ctxName. Rename the local or choose a different ctxName.`,
    );
  }

  for (const k of localKeys) assertValidIdentifier(k, "local key");

  const decls = localKeys
    .map((k) => `const ${k} = __l[${JSON.stringify(k)}];`)
    .join("\n");

  const ctxDecl = `const ${ctxName} = __ctx;`;

  // For a single expression inside $!{ ... }, the "template" is just that expr.
  const bodyLines = [
    `"use strict";`,
    decls,
    ctxDecl,
    `return (${expr});`,
  ];

  const body = bodyLines.join("\n");

  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as {
      new (
        ...args: string[]
      ): (ctx: unknown, locals: Record<string, unknown>) => Promise<unknown>;
    };

  return new AsyncFunction(
    "__ctx",
    "__l",
    body,
  ) as (ctx: unknown, locals: Record<string, unknown>) => Promise<unknown>;
}

export function renderStrategy(
  directives: readonly Directive[],
  strategyOpts?: {
    globals?: Record<string, unknown>;
    captures?: Record<string, Captured>;
  },
) {
  const simpleExprBID = "simple-expr" as const; // "BID" = "bracket ID"
  const partialBID = "partial" as const; // whatever you already use for {{ ... }}
  const unsafeBID = "unsafe" as const; // for $!{ ... }
  type BracketID = typeof simpleExprBID | typeof partialBID | typeof unsafeBID;

  const memory = flexibleMemory(directives, strategyOpts?.captures);

  const interpolate: Interpolator<
    Materializable | Executable,
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["interpolate"] = async (input, interpOpts) => {
    return {
      text: await safeInterpolateAsync(input, {
        ...interpOpts.globals,
        ...interpOpts.locals,
      }, {
        brackets: [
          { id: simpleExprBID, prefix: "$", open: "{", close: "}" },
          { id: partialBID, open: "{{", close: "}}" },
          { id: unsafeBID, prefix: "$!", open: "{", close: "}" },
        ],
        functions: {
          unsafeEval: ([code]) => eval(String(code)),
        },
        onMissing: async (expr, info) => {
          switch (info.bracketID as BracketID) {
            case "simple-expr":
              return `\$?{${expr}}`;
            case "partial": {
              const ir = instructionsFromText(expr);
              const partial = memory.partials[ir.pi.args[0]];
              if (partial) {
                const rendered = partial.render(ir.attrs);
                if (rendered.error) return rendered.text;
                const result = await interpolate(rendered.text, interpOpts);
                return result.text;
              }
              // deno-fmt-ignore
              return `partial "${name}" not found (available: ${Object.keys(memory.partials).map(p => `'${p}'`).join(", ")})`;
            }
            case "unsafe": {
              try {
                const locals = { ...interpOpts.locals, safeJsonStringify };
                const fn = compileUnsafeExpr(expr, "ctx", Object.keys(locals));
                const value = await fn(interpOpts.globals, locals);
                const result = await interpolate(
                  String(value ?? ""),
                  interpOpts,
                );
                return result.text;
              } catch (err) {
                return `$!{ERROR: ${String(err)}}`;
              }
            }
          }
        },
      }),
    };
  };

  return {
    content: actionableContent(),
    interpolator: { interpolate: interpolate },
    memory,
    globals: strategyOpts?.globals,
  };
}
