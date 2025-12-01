/**
 * Small Deno utility that generates or updates a shebang line for
 * *programmable markdown* files. The shebang points to a Spry
 * entrypoint script (usually `pm-bootstrap.ts`), and the exact location
 * is determined by an environment variable or a local/remote fallback.
 *
 * This lets us run a markdown file directly:
 *
 *     ./my-notebook.md
 *
 * The first line of the file (the shebang) decides which Spry runtime
 * is used. This script helps keep that line correct and portable.
 *
 * Programmable Markdown notebooks need a *fixed* top-level shebang so
 * Linux can execute them like scripts. But the actual Spry entrypoint
 * may move between machines, repos, checkout locations, or ephemeral
 * dev environments.
 *
 * Instead of requiring developers to manually edit the shebang,
 * we generate it automatically based on:
 *
 *   - `SPRY_PMD_ENTRYPOINT` env var (local path or remote URL)
 *   - Or fallback to `./pm-bootstrap.ts` located near this module
 *
 * This keeps notebooks portable across:
 *   - different directories
 *   - `direnv`-based setups
 *   - containerized environments
 *   - team machines with different folder structures
 *
 * ## Remote vs Local Entrypoints
 *
 * 1. **Env var is set to remote (`http://` or `https://`):**
 *    → Use it **as-is** in the shebang.
 *
 * 2. **Env var is set to a local file path:**
 *    → Normalize it and convert it to a path **relative to the current working directory**,
 *      unless `useRawEnvValue: true` is passed in options.
 *
 * 3. **Env var is not set:**
 *    → Use a resolver (by default `import.meta.resolve`) on `defaultEntrypoint`.
 *       - If it resolves to a file URL → make it relative to `cwd`.
 *       - If it resolves to a remote URL → use it as-is.
 *
 * You can override the resolver via `ShebangOptions.resolver` to plug in
 * custom resolution logic (e.g., virtual module graphs, alternate roots).
 *
 * ## Basic usage
 *
 * ```ts
 * import { shebang } from "./emitShebang.ts";
 *
 * const s = shebang();
 * console.log(await s.line());
 * await s.emit("notebook.md");
 * ```
 *
 * Or from the CLI (with a Deno task):
 *
 * ```bash
 * deno task shebang notebook.md
 * ```
 *
 * ## Exports
 *
 * ```ts
 * const { line, emit, resolveEntrypointArg } = shebang(options)
 * ```
 *
 * - `line()` → returns the shebang string.
 * - `emit(filePath?)` → prints or updates a markdown file.
 * - `resolveEntrypointArg()` → returns the resolved entrypoint for debugging.
 */

import * as path from "@std/path";

export interface ShebangOptions {
  /**
   * Name of the env var to read. Defaults to "SPRY_PMD_ENTRYPOINT".
   */
  envVarName?: string;

  /**
   * Default entrypoint specifier used when the env var is not set.
   * This will be passed to the resolver (by default import.meta.resolve).
   *
   * Example: "./pm-bootstrap.ts"
   */
  defaultEntrypoint?: string;

  /**
   * Deno permissions / flags used in the shebang.
   * Defaults to ["--allow-all"].
   */
  denoFlags?: string[];

  /**
   * If true, local FS values from the env var are used "as-is"
   * (absolute, relative, etc.), without converting to a path
   * relative to the current working directory.
   *
   * Remote URLs (http/https) are *always* used as-is regardless of this flag.
   *
   * Default: false.
   */
  useRawEnvValue?: boolean;

  /**
   * Optional resolver used to resolve the defaultEntrypoint.
   *
   * Defaults to:
   *
   *   (specifier) => import.meta.resolve(specifier)
   *
   * You can override this if you need custom resolution behavior
   * (e.g. virtual module graphs, non-standard roots).
   */
  resolver?: (specifier: string) => string | Promise<string>;
}

/**
 * Factory for shebang tools.
 *
 * Usage:
 *   const s = shebang();
 *   const line = await s.line();
 *   await s.emit("notebook.md");
 */
export function shebang(options: ShebangOptions = {}) {
  const {
    envVarName = "SPRY_PMD_ENTRYPOINT",
    defaultEntrypoint = "./pm-bootstrap.ts",
    denoFlags = ["--allow-all"],
    useRawEnvValue = false,
    resolver = (specifier: string): string => import.meta.resolve(specifier),
  } = options;

  const cwd = Deno.cwd();

  async function resolveFromEnv(raw: string): Promise<string> {
    const value = raw.trim();

    // Remote endpoints are always used as-is.
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return value;
    }

    // For local FS, caller can opt into raw usage.
    if (useRawEnvValue) {
      return value;
    }

    // Treat as a local filesystem path (absolute or relative to CWD).
    const abs = path.isAbsolute(value) ? value : path.join(cwd, value);

    // Canonicalize if possible.
    let real: string;
    try {
      real = await Deno.realPath(abs);
    } catch {
      real = abs;
    }

    // Make it relative to cwd if possible.
    const rel = path.relative(cwd, real);
    return rel || path.basename(real);
  }

  async function resolveFromDefault(): Promise<string> {
    // Use the injected resolver (sync or async).
    const resolved = await resolver(defaultEntrypoint);

    // Try to treat as file URL and make relative to cwd.
    try {
      const fsPath = path.fromFileUrl(new URL(resolved));
      const rel = path.relative(cwd, fsPath);
      return rel || path.basename(fsPath);
    } catch {
      // Not a file URL (e.g. remote) – use as-is.
      return resolved;
    }
  }

  /**
   * Resolve the entrypoint argument that will appear after `deno run` in the shebang.
   *
   * - If env var is set: apply remote/local rules.
   * - If not set: resolver(defaultEntrypoint), then:
   *   - file URL → local path relative to cwd
   *   - remote/other → use as-is
   */
  async function resolveEntrypointArg(): Promise<string> {
    const raw = Deno.env.get(envVarName);

    if (raw && raw.trim() !== "") {
      return await resolveFromEnv(raw);
    }

    return await resolveFromDefault();
  }

  /**
   * Build the full shebang line.
   */
  async function line(): Promise<string> {
    const entry = await resolveEntrypointArg();
    const flagsPart = denoFlags.join(" ");
    return `#!/usr/bin/env -S deno run ${flagsPart} ${entry}`;
  }

  /**
   * Emit the shebang:
   *
   * - If no filePath is provided -> print the shebang to stdout.
   * - If filePath is provided:
   *     - If the file already has a shebang on the first line -> replace it.
   *     - Else -> insert the shebang as the first line.
   */
  async function emit(filePath?: string): Promise<void> {
    const shebangLine = await line();

    if (!filePath) {
      console.log(shebangLine);
      return;
    }

    const original = await Deno.readTextFile(filePath);

    let updated: string;
    if (original.startsWith("#!")) {
      updated = original.replace(/^#![^\n]*\n/, `${shebangLine}\n`);
    } else {
      updated = `${shebangLine}\n${original}`;
    }

    await Deno.writeTextFile(filePath, updated);
  }

  return { line, emit, resolveEntrypointArg };
}
