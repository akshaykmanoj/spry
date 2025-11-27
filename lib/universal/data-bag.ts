// data-bag.ts
//
// Generalized, type-safe utilities for attaching arbitrary strongly-typed
// data structures onto objects that carry a `data` bag, with optional Zod
// validation and typed Web-standard events via eventBus.
//
// - Core primitives: ensureData, attachData, getData, isDataSupplier,
//   collectData, forEachData, hasAnyData
// - Deep merge helpers: deepMerge, mergeData
// - Factories (scalar/object):
//     nodeDataFactory / safeNodeDataFactory
// - Factories (array-valued):
//     nodeArrayDataFactory / safeNodeArrayDataFactory
// - Definition helpers (public surface you typically use):
//     defineNodeData / defineSafeNodeData
//     defineNodeArrayData / defineSafeNodeArrayData
// - Convenience:
//     flexibleTextSchema / mergeFlexibleText
//
// The API is fully generic and *not* tied to mdast/unist. To use with mdast:
//   - Define your own `VisitFn<Root>` that walks the tree and calls a callback
//     for each node whose shape is compatible with `DataBagNode`.
//   - Pass that VisitFn into `collect` / `forEach` / `hasAny` on factories.
//
// Example VisitFn for a unist-style tree is shown in data-bag_test.ts.

import * as z from "@zod/zod";
import { eventBus } from "./event-bus.ts";

/* -------------------------------------------------------------------------- */
/* Core structural types                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal node shape: anything with an optional `data` bag.
 *
 * You can intersect this with your own AST node types as needed.
 */
export type DataBagNode = {
  data?: Record<string, unknown>;
  // Allow arbitrary additional properties
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
};

/**
 * Node type with a strongly-typed data entry `data[Key] = T`.
 */
export type DataSupplierNode<
  N extends DataBagNode = DataBagNode,
  Key extends string = string,
  T = unknown,
> = N & {
  readonly data: {
    readonly [K in Key]: T;
  };
};

/**
 * Generic "visit" function: walks a root structure and calls `fn` for each
 * node that is compatible with DataBagNode.
 *
 * You provide this (see tests for a unist-style example).
 */
export type VisitFn<Root = unknown> = (
  root: Root,
  fn: (node: DataBagNode) => void,
) => void;

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensure `node.data` exists and return it as mutable Record.
 */
export function ensureData<N extends DataBagNode>(
  node: N,
): Record<string, unknown> {
  if (!node.data) node.data = {};
  return node.data;
}

/**
 * Attach strongly typed data under a given key.
 *
 * Returns the same node but typed as DataSupplierNode<N, Key, T>.
 * This overwrites any existing value at `data[key]`.
 */
export function attachData<
  N extends DataBagNode,
  Key extends string,
  T,
>(
  node: N,
  key: Key,
  value: T,
): DataSupplierNode<N, Key, T> {
  const data = ensureData(node);
  (data as Record<string, unknown>)[key] = value;
  return node as unknown as DataSupplierNode<N, Key, T>;
}

/**
 * Retrieve typed data from a node. Returns undefined if missing.
 *
 * If a Zod schema is supplied, the value is validated before returning.
 * Throws if validation fails.
 */
export function getData<
  T,
  N extends DataBagNode,
  Key extends string,
>(
  node: N,
  key: Key,
  schema?: z.ZodType<T>,
): T | undefined {
  const data = node.data;
  if (!data) return undefined;

  const value = (data as Record<string, unknown>)[key] as T | undefined;
  if (value === undefined) return undefined;

  if (schema) {
    return schema.parse(value);
  } else {
    return value;
  }
}

/**
 * Type guard:
 *   isDataSupplier(node, "foo") → node.data.foo exists
 *
 * Allows TS to narrow the node to DataSupplierNode<N, Key, T>.
 */
export function isDataSupplier<
  T = unknown,
  N extends DataBagNode = DataBagNode,
  Key extends string = string,
>(
  node: N,
  key: Key,
): node is DataSupplierNode<N, Key, T> {
  const data = node.data;
  return !!data && key in data;
}

/**
 * Visit the tree and collect all occurrences of a given data key.
 *
 * Returns array of typed values.
 */
export function collectData<
  T,
  Key extends string,
  Root,
>(
  root: Root,
  key: Key,
  visitFn?: VisitFn<Root>,
): readonly T[] {
  if (!visitFn) return [];
  const out: T[] = [];
  visitFn(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      out.push((node.data as Record<Key, T>)[key]);
    }
  });
  return out;
}

/**
 * Iterate all typed data bags in the tree, giving (value, owningNode).
 */
export function forEachData<
  T,
  Key extends string,
  Root,
>(
  root: Root,
  key: Key,
  fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
  visitFn?: VisitFn<Root>,
): void {
  if (!visitFn) return;
  visitFn(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      fn(
        (node.data as Record<Key, T>)[key],
        node as DataSupplierNode<DataBagNode, Key, T>,
      );
    }
  });
}

/**
 * True if *any* node in the tree has the specified typed data.
 */
export function hasAnyData<
  Key extends string,
  Root,
>(
  root: Root,
  key: Key,
  visitFn?: VisitFn<Root>,
): boolean {
  if (!visitFn) return false;
  let found = false;
  visitFn(root, (node) => {
    if (found) return;
    if (isDataSupplier(node, key)) found = true;
  });
  return found;
}

/* -------------------------------------------------------------------------- */
/* Deep merge + merging helpers                                               */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Simple deep merge for plain objects:
 * - Recursively merges nested plain objects.
 * - For arrays and primitives, source overwrites target.
 */
export function deepMerge<T>(
  target: T,
  source: Partial<T>,
): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    // Non-objects: prefer source when defined, otherwise target.
    return (source !== undefined ? source : target) as T;
  }

  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = result[key];

    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      // Arrays, primitives, etc. → overwrite
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Merge object-like data under a given key using deepMerge().
 *
 * If there is no existing value, it behaves like attachData().
 */
export function mergeData<
  N extends DataBagNode,
  Key extends string,
  T extends Record<string, unknown>,
>(
  node: N,
  key: Key,
  patch: Partial<T>,
): DataSupplierNode<N, Key, T> {
  const data = ensureData(node);
  const existing = (data as Record<string, unknown>)[key] as T | undefined;

  const next = existing ? deepMerge(existing, patch) : (patch as T);
  (data as Record<string, unknown>)[key] = next;
  return node as unknown as DataSupplierNode<N, Key, T>;
}

/* -------------------------------------------------------------------------- */
/* Event types for factories                                                  */
/* -------------------------------------------------------------------------- */

// After
export interface ScalarDataBagEvents<Key extends string, V>
  extends Record<string, unknown | void> {
  "assign": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V | undefined;
  };
  "init": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V | undefined;
  };
  "init-auto": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V | undefined;
  };
}

// Before
// export interface ArrayDataBagEvents<Key extends string, T> {
//   "assign": { ... };
//   "init": { ... };
//   "init-auto": { ... };
//   "add": { ... };
// }

// After
export interface ArrayDataBagEvents<Key extends string, T>
  extends Record<string, unknown | void> {
  "assign": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly T[] | undefined;
    readonly next: readonly T[] | undefined;
  };
  "init": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly T[] | undefined;
    readonly next: readonly T[] | undefined;
  };
  "init-auto": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly T[] | undefined;
    readonly next: readonly T[] | undefined;
  };
  "add": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly T[] | undefined;
    readonly added: readonly T[];
    readonly next: readonly T[];
  };
}

/* -------------------------------------------------------------------------- */
/* Scalar/object Data factories (unsafe, no Zod)                              */
/* -------------------------------------------------------------------------- */

export interface DataFactoryOptions<T> {
  /**
   * If true, attach() will deep-merge new values with existing values when both
   * are plain objects. For non-plain objects, attach() falls back to overwrite.
   */
  merge?: boolean;

  /**
   * Optional lazy initializer. Called to prepare the data bag for a node.
   * The same callback is used for manual `factory.init(node)` and automatic
   * first-access initialization.
   */
  init?: (
    node: DataBagNode,
    ctx: {
      factory: DataFactory<string, unknown>;
      onFirstAccessAuto?: boolean;
    },
  ) => void;

  /**
   * If true, the init callback is invoked automatically the first time the
   * factory is accessed for a given node (via get/safeGet or is(..., "auto-init")).
   */
  initOnFirstAccess?: boolean;

  /**
   * If true and both `init` and `initOnFirstAccess` are set, calling
   * `factory.is(node)` (no mode argument) is allowed to auto-init the node
   * before checking for data. Default: false.
   *
   * `factory.is(node, "auto-init")` will *always* allow auto-init regardless
   * of this flag.
   */
  autoInitOnIs?: boolean;
}

export interface DataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  /**
   * Typed event bus for this factory.
   *
   * Events:
   * - "assign": fired on attach/merge, with previous/next values
   * - "init": fired after an explicit `factory.init(node, { onFirstAccessAuto: false })`
   * - "init-auto": fired after an implicit first-access or is(..., "auto-init") init
   */
  readonly events: ReturnType<typeof eventBus<ScalarDataBagEvents<Key, T>>>;

  /**
   * Attach a value (overwriting or merging based on options).
   */
  attach<N extends DataBagNode>(node: N, value: T): DataSupplierNode<N, Key, T>;

  /**
   * Raw access: returns whatever is stored under the key (no validation).
   *
   * If `ifNotExists` is provided and the key is absent, it will be called to
   * create a value, which is then attached to the node and returned.
   */
  get<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  /**
   * For "unsafe" factories (no schema), safeGet is equivalent to get().
   * Signature is the same for ergonomic symmetry.
   */
  safeGet<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  /**
   * Type guard for nodes that currently have the key set.
   *
   * - `is(node)` is pure unless `autoInitOnIs: true` (and init/initOnFirstAccess set),
   *   in which case it may perform auto-init once.
   * - `is(node, "auto-init")` is allowed to auto-init (if configured) and then
   *   returns a type guard if data is attached.
   */
  is<N extends DataBagNode>(
    node: N,
  ): node is DataSupplierNode<N, Key, T>;
  is<N extends DataBagNode>(
    node: N,
    mode: "auto-init",
  ): node is DataSupplierNode<N, Key, T>;

  /**
   * Non-guard, side-effect free hint:
   * True if data is currently present *or* could appear via lazy init.
   */
  isPossibly<N extends DataBagNode>(node: N): boolean;

  /**
   * Collect all values from a visited root.
   */
  collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[];

  /**
   * Like collect(), but returns the owning nodes instead of the values.
   */
  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
    visitFn?: VisitFn<Root>,
  ): readonly DataSupplierNode<N, Key, T>[];

  forEach<Root>(
    root: Root,
    fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
    visitFn?: VisitFn<Root>,
  ): void;

  hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean;

  /**
   * Explicit initializer. Calls the user-provided `options.init`, if present,
   * and emits an "init" or "init-auto" event (depending on ctx.onFirstAccessAuto).
   */
  init<N extends DataBagNode>(
    node: N,
    ctx?: { onFirstAccessAuto?: boolean },
  ): void;
}

/**
 * Create a data factory bound to a specific key (no Zod validation).
 */
export function nodeDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  options?: DataFactoryOptions<T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const events = eventBus<ScalarDataBagEvents<Key, T>>();

  const factory: DataFactory<Key, T> = {
    key,
    events,

    attach<N extends DataBagNode>(node: N, value: T) {
      const previous = getData<T, N, Key>(node, key);
      const next: T = (() => {
        if (!mergeEnabled) return value;
        if (
          previous !== undefined &&
          isPlainObject(previous) &&
          isPlainObject(value)
        ) {
          return deepMerge(previous, value as Partial<T>);
        }
        return value;
      })();

      const result = attachData<N, Key, T>(node, key, next);
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    get<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T | null | undefined,
    ): T | undefined {
      const existing = getData<T, N, Key>(node, key);
      if (existing !== undefined) return existing;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === null || created === undefined) return undefined;
      return factory.attach(node, created).data[key];
    },

    safeGet<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T | null | undefined,
    ): T | undefined {
      // Unsafe factory: safeGet == get
      return this.get(node, ifNotExists);
    },

    is<N extends DataBagNode>(
      node: N,
      mode?: "auto-init",
    ): node is DataSupplierNode<N, Key, T> {
      if (isDataSupplier<T, N, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T, N, Key>(node, key);
      }

      return false;
    },

    isPossibly<N extends DataBagNode>(node: N): boolean {
      if (isDataSupplier<T, N, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[] {
      return collectData<T, Key, Root>(root, key, visitFn);
    },

    collectNodes<Root, N extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn?: VisitFn<Root>,
    ): readonly DataSupplierNode<N, Key, T>[] {
      const out: DataSupplierNode<DataBagNode, Key, T>[] = [];
      forEachData<T, Key, Root>(
        root,
        key,
        (_value, owner) => {
          out.push(owner as DataSupplierNode<DataBagNode, Key, T>);
        },
        visitFn,
      );
      return out as DataSupplierNode<N, Key, T>[];
    },

    forEach<Root>(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
      visitFn?: VisitFn<Root>,
    ): void {
      forEachData<T, Key, Root>(root, key, fn, visitFn);
    },

    hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean {
      return hasAnyData<Key, Root>(root, key, visitFn);
    },

    init<N extends DataBagNode>(
      node: N,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<T, N, Key>(node, key);
      options.init(node, {
        factory: factory as unknown as DataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<T, N, Key>(node, key);
      events.emit(ctx?.onFirstAccessAuto ? "init-auto" : "init", {
        key,
        node,
        previous,
        next,
      });
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Safe factories (Zod-backed, callback-driven error handling)                */
/* -------------------------------------------------------------------------- */

export interface SafeDataFactoryOptions<T> extends DataFactoryOptions<T> {
  /**
   * Called when attach() fails safeParse on the new value.
   *
   * Return:
   * - T: replacement value which will then be attached (and validated again).
   * - null | undefined: do nothing (value is not stored).
   */
  onAttachSafeParseError?: (ctx: {
    node: DataBagNode;
    attemptedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  /**
   * Called when attach() with merge=true fails safeParse on an existing value.
   *
   * Return:
   * - T: replacement value which is used as the "existing" side for merge.
   * - null | undefined: treat as if there was no existing value.
   */
  onExistingSafeParseError?: (ctx: {
    node: DataBagNode;
    existingValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  /**
   * Called when safeGet() fails safeParse on the stored value.
   *
   * Return:
   * - T: replacement value which safeGet() will return.
   * - null | undefined: safeGet() returns undefined.
   */
  onSafeGetSafeParseError?: (ctx: {
    node: DataBagNode;
    storedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;
}

/**
 * Helper to safeParse a value and, on error, delegate to a callback
 * which can provide a replacement or decline to handle.
 */
function safeParseWithHandler<T>(
  node: DataBagNode,
  value: unknown,
  schema: z.ZodType<T>,
  handler:
    | ((ctx: {
      node: DataBagNode;
      storedValue?: unknown;
      attemptedValue?: unknown;
      existingValue?: unknown;
      error: z.ZodError<T>;
    }) => T | null | undefined)
    | undefined,
  kind:
    | "attach"
    | "existing"
    | "safeGet",
): T | undefined {
  const res = schema.safeParse(value);
  if (res.success) return res.data as T;

  if (!handler) return undefined;

  const ctxBase = {
    node,
    error: res.error,
  };

  let replacement: T | null | undefined;

  switch (kind) {
    case "attach":
      replacement = handler({
        ...ctxBase,
        attemptedValue: value,
      });
      break;
    case "existing":
      replacement = handler({
        ...ctxBase,
        existingValue: value,
      });
      break;
    case "safeGet":
      replacement = handler({
        ...ctxBase,
        storedValue: value,
      });
      break;
  }

  if (replacement === null || replacement === undefined) return undefined;

  const again = schema.safeParse(replacement);
  return again.success ? (again.data as T) : undefined;
}

/**
 * Create a Zod-backed data factory that never throws.
 *
 * - On attach(): safeParse the incoming value; on error, call
 *   options.onAttachSafeParseError. Depending on its return value, may attach
 *   a replacement or skip attaching.
 * - On merge attach(): also safeParse the existing value; on error, call
 *   options.onExistingSafeParseError.
 * - On safeGet(): safeParse existing stored value; on error, call
 *   options.onSafeGetSafeParseError.
 *
 * - get(): returns raw stored value (no validation, no logging).
 * - Both get/safeGet accept an optional `ifNotExists` callback:
 *   - If no stored value and callback is provided, it is called to create
 *     a value, which is attached and returned (no extra Zod or callbacks).
 */
export function safeNodeDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  schema: z.ZodType<T>,
  options?: SafeDataFactoryOptions<T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const events = eventBus<ScalarDataBagEvents<Key, T>>();

  const factory: DataFactory<Key, T> = {
    key,
    events,

    attach<N extends DataBagNode>(node: N, value: T) {
      const parsed = safeParseWithHandler<T>(
        node,
        value,
        schema,
        options?.onAttachSafeParseError
          ? (ctx) =>
            options.onAttachSafeParseError?.({
              node: ctx.node,
              attemptedValue: ctx.attemptedValue,
              error: ctx.error,
            })
          : undefined,
        "attach",
      );

      if (parsed === undefined) {
        // Validation failed and handler declined to fix it.
        return node as unknown as DataSupplierNode<N, Key, T>;
      }

      if (!mergeEnabled) {
        const previous = getData<T, N, Key>(node, key);
        const result = attachData<N, Key, T>(node, key, parsed);
        events.emit("assign", { key, node, previous, next: parsed });
        return result;
      }

      const existingRaw = getData<unknown, N, Key>(node, key);
      let existingParsed: T | undefined;

      if (existingRaw !== undefined) {
        existingParsed = safeParseWithHandler<T>(
          node,
          existingRaw,
          schema,
          options?.onExistingSafeParseError
            ? (ctx) =>
              options.onExistingSafeParseError?.({
                node: ctx.node,
                existingValue: ctx.existingValue,
                error: ctx.error,
              })
            : undefined,
          "existing",
        );
      }

      let next: T;
      if (
        existingParsed !== undefined &&
        isPlainObject(existingParsed) &&
        isPlainObject(parsed)
      ) {
        next = deepMerge(existingParsed, parsed as Partial<T>);
      } else {
        next = parsed;
      }

      const previous = existingParsed ?? undefined;
      const result = attachData<N, Key, T>(node, key, next);
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    get<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T | null | undefined,
    ): T | undefined {
      // Raw, unvalidated access: no Zod, no callbacks.
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) return raw as T;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === null || created === undefined) return undefined;
      return factory.attach(node, created).data[key];
    },

    safeGet<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T | null | undefined,
    ): T | undefined {
      const raw = getData<unknown, N, Key>(node, key);

      if (raw !== undefined) {
        const parsed = safeParseWithHandler<T>(
          node,
          raw,
          schema,
          options?.onSafeGetSafeParseError
            ? (ctx) =>
              options.onSafeGetSafeParseError?.({
                node: ctx.node,
                storedValue: ctx.storedValue,
                error: ctx.error,
              })
            : undefined,
          "safeGet",
        );
        return parsed;
      }

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === null || created === undefined) return undefined;

      // We trust the provided default and attach it directly.
      return factory.attach(node, created).data[key];
    },

    is<N extends DataBagNode>(
      node: N,
      mode?: "auto-init",
    ): node is DataSupplierNode<N, Key, T> {
      if (isDataSupplier<T, N, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T, N, Key>(node, key);
      }

      return false;
    },

    isPossibly<N extends DataBagNode>(node: N): boolean {
      if (isDataSupplier<T, N, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[] {
      return collectData<T, Key, Root>(root, key, visitFn);
    },

    collectNodes<Root, N extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn?: VisitFn<Root>,
    ): readonly DataSupplierNode<N, Key, T>[] {
      const out: DataSupplierNode<DataBagNode, Key, T>[] = [];
      forEachData<T, Key, Root>(
        root,
        key,
        (_value, owner) => {
          out.push(owner as DataSupplierNode<DataBagNode, Key, T>);
        },
        visitFn,
      );
      return out as DataSupplierNode<N, Key, T>[];
    },

    forEach<Root>(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
      visitFn?: VisitFn<Root>,
    ): void {
      forEachData<T, Key, Root>(root, key, fn, visitFn);
    },

    hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean {
      return hasAnyData<Key, Root>(root, key, visitFn);
    },

    init<N extends DataBagNode>(
      node: N,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<T, N, Key>(node, key);
      options.init(node, {
        factory: factory as unknown as DataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<T, N, Key>(node, key);
      events.emit(ctx?.onFirstAccessAuto ? "init-auto" : "init", {
        key,
        node,
        previous,
        next,
      });
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Array-valued factories (unsafe, no Zod)                                    */
/* -------------------------------------------------------------------------- */

export interface ArrayDataFactoryOptions {
  /**
   * If true (default), add() appends to any existing array.
   * If false, add() replaces the array with the new items.
   */
  merge?: boolean;

  /**
   * Optional lazy initializer for the array bag.
   */
  init?: (
    node: DataBagNode,
    ctx: {
      factory: ArrayDataFactory<string, unknown>;
      onFirstAccessAuto?: boolean;
    },
  ) => void;

  /**
   * If true, the init callback is invoked automatically the first time the
   * factory is accessed for a given node (via get/safeGet or is(..., "auto-init")).
   */
  initOnFirstAccess?: boolean;

  /**
   * If true and both `init` and `initOnFirstAccess` are set, calling
   * `factory.is(node)` (no mode argument) is allowed to auto-init the node
   * before checking for data. Default: false.
   */
  autoInitOnIs?: boolean;
}

export interface ArrayDataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  readonly events: ReturnType<typeof eventBus<ArrayDataBagEvents<Key, T>>>;

  // Append or replace items in the per-node array (depending on merge option)
  add<N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): DataSupplierNode<N, Key, T[]>;

  /**
   * Raw access: always returns an array (empty if none stored yet).
   *
   * If `ifNotExists` is provided and no array is stored yet, it will be called
   * to create an initial array, which is then attached and returned.
   */
  get<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  /**
   * For "unsafe" factories (no schema), safeGet is equivalent to get().
   */
  safeGet<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  // Type guard for nodes that have an array at this key
  is<N extends DataBagNode>(
    node: N,
  ): node is DataSupplierNode<N, Key, T[]>;
  is<N extends DataBagNode>(
    node: N,
    mode: "auto-init",
  ): node is DataSupplierNode<N, Key, T[]>;

  isPossibly<N extends DataBagNode>(node: N): boolean;

  // Flatten all arrays from all nodes into a single array
  collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[];

  /**
   * Like collect(), but returns the owning nodes (one per node) instead
   * of individual items. Nodes with empty or non-array buckets are skipped.
   */
  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
    visitFn?: VisitFn<Root>,
  ): readonly DataSupplierNode<N, Key, T[]>[];

  // Visit each individual item together with its owning node
  forEach<Root>(
    root: Root,
    fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
    visitFn?: VisitFn<Root>,
  ): void;

  // True if any node has a non-empty array for this key
  hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean;

  init<N extends DataBagNode>(
    node: N,
    ctx?: { onFirstAccessAuto?: boolean },
  ): void;
}

/**
 * Create an array-valued data factory bound to a specific key (no validation).
 */
export function nodeArrayDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  options?: ArrayDataFactoryOptions,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const events = eventBus<ArrayDataBagEvents<Key, T>>();

  const factory: ArrayDataFactory<Key, T> = {
    key,
    events,

    add<N extends DataBagNode>(node: N, ...items: readonly T[]) {
      const existingRaw = merge ? getData<T[], N, Key>(node, key) ?? [] : [];
      const previous = existingRaw ?? undefined;
      const base = Array.isArray(existingRaw) ? existingRaw : [];
      const next = base.concat(items);
      const result = attachData<N, Key, T[]>(node, key, next);
      events.emit("add", { key, node, previous, added: items, next });
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    get<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const existing = getData<T[], N, Key>(node, key);
      if (existing !== undefined) return existing as T[];

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      const result = attachData<N, Key, T[]>(node, key, created);
      // For raw get, we treat created as assign.
      events.emit("assign", {
        key,
        node,
        previous: undefined,
        next: created,
      });
      return result.data[key];
    },

    safeGet<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      // Unsafe factory: safeGet == get
      return this.get(node, ifNotExists);
    },

    is<N extends DataBagNode>(
      node: N,
      mode?: "auto-init",
    ): node is DataSupplierNode<N, Key, T[]> {
      if (isDataSupplier<T[], N, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T[], N, Key>(node, key);
      }

      return false;
    },

    isPossibly<N extends DataBagNode>(node: N): boolean {
      if (isDataSupplier<T[], N, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[] {
      const buckets = collectData<T[], Key, Root>(root, key, visitFn);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<Root, N extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn?: VisitFn<Root>,
    ): readonly DataSupplierNode<N, Key, T[]>[] {
      const out: DataSupplierNode<DataBagNode, Key, T[]>[] = [];
      const seen = new Set<DataSupplierNode<DataBagNode, Key, T[]>>();

      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket, owner) => {
          if (!Array.isArray(bucket) || bucket.length === 0) return;

          const typedOwner = owner as DataSupplierNode<
            DataBagNode,
            Key,
            T[]
          >;
          if (seen.has(typedOwner)) return;

          seen.add(typedOwner);
          out.push(typedOwner);
        },
        visitFn,
      );

      return out as DataSupplierNode<N, Key, T[]>[];
    },

    forEach<Root>(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
      visitFn?: VisitFn<Root>,
    ): void {
      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket, owner) => {
          if (!Array.isArray(bucket)) return;
          for (const item of bucket) {
            fn(item, owner as DataSupplierNode<DataBagNode, Key, T[]>);
          }
        },
        visitFn,
      );
    },

    hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean {
      let found = false;
      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket) => {
          if (!found && Array.isArray(bucket) && bucket.length > 0) {
            found = true;
          }
        },
        visitFn,
      );
      return found;
    },

    init<N extends DataBagNode>(
      node: N,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<T[], N, Key>(node, key) ?? undefined;
      options.init(node, {
        factory: factory as unknown as ArrayDataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<T[], N, Key>(node, key) ?? undefined;
      events.emit(ctx?.onFirstAccessAuto ? "init-auto" : "init", {
        key,
        node,
        previous,
        next,
      });
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Safe array-valued factories (Zod-backed)                                   */
/* -------------------------------------------------------------------------- */

export interface SafeArrayDataFactoryOptions<T>
  extends ArrayDataFactoryOptions {
  /**
   * Called when add() fails safeParse on the incoming items.
   *
   * Return:
   * - T[]: replacement array of items to use instead.
   * - null | undefined: do nothing (no items stored).
   */
  onAddSafeParseError?: (ctx: {
    node: DataBagNode;
    attemptedItems: readonly unknown[];
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  /**
   * Called when add() with merge=true fails safeParse on an existing array.
   *
   * Return:
   * - T[]: replacement array used as the "existing" side for merge.
   * - null | undefined: treat as if there was no existing array.
   */
  onExistingSafeParseError?: (ctx: {
    node: DataBagNode;
    existingValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  /**
   * Called when safeGet() fails safeParse on the stored array.
   *
   * Return:
   * - T[]: replacement array which safeGet() will return.
   * - null | undefined: safeGet() returns [].
   */
  onSafeGetSafeParseError?: (ctx: {
    node: DataBagNode;
    storedValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;
}

/**
 * Create a Zod-backed array-valued data factory that never throws.
 *
 * - Stores `T[]` at `node.data[key]`.
 * - add(): validates incoming items (and existing array if present when
 *   merge=true), delegating errors to callbacks in options.
 * - safeGet(): validates stored array, delegating errors to callbacks.
 * - get(): returns raw stored array or [] if missing (no validation).
 * - Both get/safeGet accept `ifNotExists`, which creates & attaches a default
 *   array when missing (no extra validation).
 */
export function safeNodeArrayDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  itemSchema: z.ZodType<T>,
  options?: SafeArrayDataFactoryOptions<T>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const arraySchema = z.array(itemSchema);
  const events = eventBus<ArrayDataBagEvents<Key, T>>();

  const factory: ArrayDataFactory<Key, T> = {
    key,
    events,

    add<N extends DataBagNode>(node: N, ...items: readonly T[]) {
      // Validate the incoming items as an array
      const parsedItems = ((): T[] | undefined => {
        const res = arraySchema.safeParse(items);
        if (res.success) return res.data;

        if (!options?.onAddSafeParseError) return undefined;
        const replacement = options.onAddSafeParseError({
          node,
          attemptedItems: items,
          error: res.error,
        });

        if (!replacement) return undefined;
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : undefined;
      })();

      if (!parsedItems) {
        return node as unknown as DataSupplierNode<N, Key, T[]>;
      }

      const existingRaw = merge
        ? getData<unknown, N, Key>(node, key)
        : undefined;

      const existingParsed = ((): T[] | undefined => {
        if (existingRaw === undefined) return undefined;

        const res = arraySchema.safeParse(existingRaw);
        if (res.success) return res.data;

        if (!options?.onExistingSafeParseError) return undefined;
        const replacement = options.onExistingSafeParseError({
          node,
          existingValue: existingRaw,
          error: res.error,
        });

        if (!replacement) return undefined;
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : undefined;
      })();

      const previous = existingParsed ?? undefined;
      const base: T[] = existingParsed ?? [];
      const next = base.concat(parsedItems);
      const result = attachData<N, Key, T[]>(node, key, next);

      events.emit("add", { key, node, previous, added: parsedItems, next });
      events.emit("assign", { key, node, previous, next });

      return result;
    },

    get<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) return raw as T[];

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      const result = attachData<N, Key, T[]>(node, key, created);
      events.emit("assign", {
        key,
        node,
        previous: undefined,
        next: created,
      });
      return result.data[key];
    },

    safeGet<N extends DataBagNode>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) {
        const res = arraySchema.safeParse(raw);
        if (res.success) return res.data;

        if (!options?.onSafeGetSafeParseError) return [];
        const replacement = options.onSafeGetSafeParseError({
          node,
          storedValue: raw,
          error: res.error,
        });

        if (!replacement) return [];
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : [];
      }

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      const result = attachData<N, Key, T[]>(node, key, created);
      events.emit("assign", {
        key,
        node,
        previous: undefined,
        next: created,
      });
      return result.data[key];
    },

    is<N extends DataBagNode>(
      node: N,
      mode?: "auto-init",
    ): node is DataSupplierNode<N, Key, T[]> {
      if (isDataSupplier<T[], N, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T[], N, Key>(node, key);
      }

      return false;
    },

    isPossibly<N extends DataBagNode>(node: N): boolean {
      if (isDataSupplier<T[], N, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn?: VisitFn<Root>): readonly T[] {
      const buckets = collectData<T[], Key, Root>(root, key, visitFn);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<Root, N extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn?: VisitFn<Root>,
    ): readonly DataSupplierNode<N, Key, T[]>[] {
      const out: DataSupplierNode<DataBagNode, Key, T[]>[] = [];
      const seen = new Set<DataSupplierNode<DataBagNode, Key, T[]>>();

      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket, owner) => {
          if (!Array.isArray(bucket) || bucket.length === 0) return;

          const typedOwner = owner as DataSupplierNode<
            DataBagNode,
            Key,
            T[]
          >;
          if (seen.has(typedOwner)) return;

          seen.add(typedOwner);
          out.push(typedOwner);
        },
        visitFn,
      );

      return out as DataSupplierNode<N, Key, T[]>[];
    },

    forEach<Root>(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
      visitFn?: VisitFn<Root>,
    ): void {
      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket, owner) => {
          if (!Array.isArray(bucket)) return;
          for (const item of bucket) {
            fn(item, owner as DataSupplierNode<DataBagNode, Key, T[]>);
          }
        },
        visitFn,
      );
    },

    hasAny<Root>(root: Root, visitFn?: VisitFn<Root>): boolean {
      let found = false;
      forEachData<T[], Key, Root>(
        root,
        key,
        (bucket) => {
          if (!found && Array.isArray(bucket) && bucket.length > 0) {
            found = true;
          }
        },
        visitFn,
      );
      return found;
    },

    init<N extends DataBagNode>(
      node: N,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<T[], N, Key>(node, key) ?? undefined;
      options.init(node, {
        factory: factory as unknown as ArrayDataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<T[], N, Key>(node, key) ?? undefined;
      events.emit(ctx?.onFirstAccessAuto ? "init-auto" : "init", {
        key,
        node,
        previous,
        next,
      });
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Flexible text helpers                                                      */
/* -------------------------------------------------------------------------- */

export const flexibleTextSchema = z.union([z.string(), z.array(z.string())]);
export type FlexibleText = z.infer<typeof flexibleTextSchema>;

export const mergeFlexibleText = (
  shortcut?: FlexibleText,
  long?: FlexibleText,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  if (shortcut !== undefined) {
    if (Array.isArray(shortcut)) {
      for (const s of shortcut) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    } else if (!seen.has(shortcut)) {
      seen.add(shortcut);
      out.push(shortcut);
    }
  }

  if (long !== undefined) {
    if (Array.isArray(long)) {
      for (const s of long) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    } else if (!seen.has(long)) {
      seen.add(long);
      out.push(long);
    }
  }

  return out;
};

/* -------------------------------------------------------------------------- */
/* Data definition helpers (scalar/object data)                               */
/* -------------------------------------------------------------------------- */

export interface NodeDataDef<
  Key extends string,
  T,
  N extends DataBagNode = DataBagNode,
> {
  readonly key: Key;
  readonly factory: DataFactory<Key, T>;

  // Phantom types for extraction
  readonly _data?: T;
  readonly _node?: N;
}

/**
 * Create a definition for scalar/object data.
 *
 * Usage:
 *   const codeFrontmatterDef =
 *     defineNodeData("codeFM" as const)<CodeFrontmatter, Code>({
 *       merge: true,
 *     });
 */
export function defineNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: DataFactoryOptions<T>,
  ): NodeDataDef<Key, T, N> => ({
    key,
    factory: nodeDataFactory<Key, T>(key, options),
  });
}

/**
 * Zod-backed version.
 *
 * Usage:
 *   const safeCodeFrontmatterDef =
 *     defineSafeNodeData("codeFM" as const)<CodeFrontmatter, Code>(
 *       codeFrontmatterSchema,
 *       { merge: true },
 *     );
 */
export function defineSafeNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    schema: z.ZodType<T>,
    options?: SafeDataFactoryOptions<T>,
  ): NodeDataDef<Key, T, N> => ({
    key,
    factory: safeNodeDataFactory<Key, T>(key, schema, options),
  });
}

// ---------------------------------------------------------------------------
// Type extractors for scalar/object data
// ---------------------------------------------------------------------------

export type NodeDataKey<
  Def extends NodeDataDef<string, unknown, DataBagNode>,
> = Def["key"];

export type NodeDataType<
  Def extends NodeDataDef<string, unknown, DataBagNode>,
> = Def extends NodeDataDef<string, infer T, DataBagNode> ? T : never;

export type NodeDataNode<
  Def extends NodeDataDef<string, unknown, DataBagNode>,
> = Def extends NodeDataDef<string, unknown, infer N> ? N : never;

/**
 * Rebuild DataSupplierNode from a NodeDataDef.
 *
 * By default uses the Node type encoded in the definition,
 * but you can override N to be more generic if you want.
 */
export type NodeWithData<
  Def extends NodeDataDef<string, unknown, DataBagNode>,
  N extends DataBagNode = NodeDataNode<Def>,
> = DataSupplierNode<
  N,
  NodeDataKey<Def>,
  NodeDataType<Def>
>;

// ---------------------------------------------------------------------------
// Data definition helpers (array-valued data)
// ---------------------------------------------------------------------------

export interface NodeArrayDataDef<
  Key extends string,
  T,
  N extends DataBagNode = DataBagNode,
> {
  readonly key: Key;
  readonly factory: ArrayDataFactory<Key, T>;

  // Phantom types
  readonly _item?: T;
  readonly _node?: N;
}

/**
 * Create an array-valued definition.
 *
 * Usage:
 *   const tagsDef =
 *     defineNodeArrayData("tags" as const)<string, Paragraph>({ merge: true });
 */
export function defineNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: ArrayDataFactoryOptions,
  ): NodeArrayDataDef<Key, T, N> => ({
    key,
    factory: nodeArrayDataFactory<Key, T>(key, options),
  });
}

/**
 * Zod-backed array-valued definition.
 *
 * Usage:
 *   const safeTagsDef =
 *     defineSafeNodeArrayData("tags" as const)<string, Paragraph>(
 *       z.string(),
 *       { merge: true },
 *     );
 */
export function defineSafeNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    itemSchema: z.ZodType<T>,
    options?: SafeArrayDataFactoryOptions<T>,
  ): NodeArrayDataDef<Key, T, N> => ({
    key,
    factory: safeNodeArrayDataFactory<Key, T>(key, itemSchema, options),
  });
}

// ---------------------------------------------------------------------------
// Type extractors for array-valued data
// ---------------------------------------------------------------------------

export type NodeArrayKey<
  Def extends NodeArrayDataDef<string, unknown, DataBagNode>,
> = Def["key"];

export type NodeArrayItem<
  Def extends NodeArrayDataDef<string, unknown, DataBagNode>,
> = Def extends NodeArrayDataDef<string, infer T, DataBagNode> ? T : never;

export type NodeArrayNode<
  Def extends NodeArrayDataDef<string, unknown, DataBagNode>,
> = Def extends NodeArrayDataDef<string, unknown, infer N> ? N : never;

/**
 * Rebuild DataSupplierNode from a NodeArrayDataDef.
 * Data is `Item[]`.
 */
export type NodeWithArrayData<
  Def extends NodeArrayDataDef<string, unknown, DataBagNode>,
  N extends DataBagNode = NodeArrayNode<Def>,
> = DataSupplierNode<
  N,
  NodeArrayKey<Def>,
  NodeArrayItem<Def>[]
>;
