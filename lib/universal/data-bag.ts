// lib/universal/data-bag.ts
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
 * The `Data` generic is intentionally *unconstrained*; we don't require
 * a Record or an index signature. When we need map-like behavior, we cast
 * to `Record<string, unknown>` internally.
 */
export type DataBagNode<Data = unknown> = {
  data?: Data;
};

/**
 * Node type with a strongly-typed data entry `data[Key] = T`.
 *
 * This is a *view* over the node: we preserve whatever `N["data"]` is
 * (if it's an object) and intersect it with `{ [Key]: T }`.
 */
export type DataSupplierNode<
  N extends DataBagNode = DataBagNode,
  Key extends string = string,
  T = unknown,
> = N & {
  readonly data:
    & (N["data"] extends object ? N["data"]
      : Record<string, unknown>)
    & {
      readonly [K in Key]: T;
    };
};

/**
 * Generic "visit" function: walks a root structure and calls `fn` for each
 * node that is compatible with DataBagNode.
 *
 * You provide this (see mdast adapter for a unist-style example).
 */
export type VisitFn<Root = unknown> = (
  root: Root,
  fn: (node: DataBagNode) => void,
) => void;

/* -------------------------------------------------------------------------- */
/* Internal helpers for treating node.data as a bag                           */
/* -------------------------------------------------------------------------- */

function ensureDataRecord(node: DataBagNode): Record<string, unknown> {
  const current = node.data;
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current)
  ) {
    // Reuse existing object as the backing bag.
    return current as Record<string, unknown>;
  }

  const bag: Record<string, unknown> = {};
  node.data = bag as unknown as typeof node.data;
  return bag;
}

function dataRecordOrUndefined(
  node: DataBagNode,
): Record<string, unknown> | undefined {
  const current = node.data;
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current)
  ) {
    return current as Record<string, unknown>;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensure `node.data` exists and return it as a mutable Record view.
 *
 * This does *not* change the static type of `node.data`; it just ensures at
 * runtime that there's an object backing the bag and returns it as a Record.
 */
export function ensureData<N extends DataBagNode>(
  node: N,
): Record<string, unknown> {
  return ensureDataRecord(node);
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
  const bag = ensureDataRecord(node);
  bag[key] = value as unknown;
  return node as unknown as DataSupplierNode<N, Key, T>;
}

/**
 * Pure variant: does not mutate the original node. Instead, it returns a
 * shallowly cloned node whose `data[key]` is set to `value`.
 */
export function withAttachedData<
  N extends DataBagNode,
  Key extends string,
  T,
>(
  node: N,
  key: Key,
  value: T,
): DataSupplierNode<N, Key, T> {
  const cloned = { ...node } as N;
  const bag = ensureDataRecord(cloned);
  bag[key] = value as unknown;
  return cloned as DataSupplierNode<N, Key, T>;
}

/**
 * Retrieve typed data from a node. Returns undefined if missing.
 *
 * If a Zod schema is supplied, the value is validated before returning.
 * Throws if validation fails.
 *
 * T is usually inferred either from the schema or from your usage site.
 */
export function getData<
  N extends DataBagNode,
  Key extends string,
  T = unknown,
>(
  node: N,
  key: Key,
  schema?: z.ZodType<T>,
): T | undefined {
  const bag = dataRecordOrUndefined(node);
  if (!bag) return undefined;

  const value = bag[key] as T | undefined;
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
  const bag = dataRecordOrUndefined(node);
  return !!bag && key in bag;
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
  visitFn: VisitFn<Root>,
): readonly T[] {
  const out: T[] = [];
  visitFn(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      const bag = node.data as Record<Key, T>;
      out.push(bag[key]);
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
  visitFn: VisitFn<Root>,
): void {
  visitFn(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      const bag = node.data as Record<Key, T>;
      fn(bag[key], node as DataSupplierNode<DataBagNode, Key, T>);
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
  visitFn: VisitFn<Root>,
): boolean {
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
    return (source !== undefined ? source : target) as T;
  }

  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = result[key];

    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
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
  const bag = ensureDataRecord(node);
  const existing = bag[key] as T | undefined;

  const next = existing ? deepMerge(existing, patch) : (patch as T);
  bag[key] = next;
  return node as unknown as DataSupplierNode<N, Key, T>;
}

/* -------------------------------------------------------------------------- */
/* Event types for factories                                                  */
/* -------------------------------------------------------------------------- */

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

export interface DataFactoryOptions<
  T,
  N extends DataBagNode = DataBagNode,
> {
  merge?: boolean;
  /**
   * Optional lazy initializer. Called to prepare the data bag for a node.
   * The same callback is used for manual `factory.init(node)` and automatic
   * first-access initialization.
   *
   * Note: `N` is the *concrete* node type you passed into `defineNodeData`
   * (e.g. mdast `Code`), so `init` sees the real node type.
   */
  readonly init?: (
    node: N,
    ctx: {
      factory: DataFactory<string, unknown>;
      onFirstAccessAuto?: boolean;
    },
  ) => void;
  readonly initOnFirstAccess?: boolean;
}

/**
 * Result of attach/get/safeGet when you want to observe parse / init issues
 * explicitly rather than only via events.
 */
export type DataFactoryResult<T> =
  | { ok: true; value: T | undefined }
  | { ok: false; error: unknown };

/**
 * Minimal scalar factory interface.
 */
export interface DataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;
  readonly events: ReturnType<typeof eventBus<ScalarDataBagEvents<Key, T>>>;

  attach<N extends DataBagNode>(node: N, value: T): DataSupplierNode<N, Key, T>;

  get<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  safeGet<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  /**
   * Variant of safeGet that wraps any parse/handler failure and exposes
   * it directly to the caller.
   *
   * For "unsafe" factories, this is simply `{ ok: true, value: get(...) }`.
   */
  safeGetResult<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): DataFactoryResult<T>;

  is<N extends DataBagNode>(
    node: N,
  ): node is DataSupplierNode<N, Key, T>;
  is<N extends DataBagNode>(
    node: N,
    mode: "auto-init",
  ): node is DataSupplierNode<N, Key, T>;

  isPossibly<N extends DataBagNode>(node: N): boolean;

  collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[];

  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
    visitFn: VisitFn<Root>,
  ): readonly DataSupplierNode<N, Key, T>[];

  forEach<Root>(
    root: Root,
    fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
    visitFn: VisitFn<Root>,
  ): void;

  hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean;

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
  N extends DataBagNode = DataBagNode,
>(
  key: Key,
  options?: DataFactoryOptions<T, N>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const events = eventBus<ScalarDataBagEvents<Key, T>>();

  const factory: DataFactory<Key, T> = {
    key,
    events,

    attach<M extends DataBagNode>(node: M, value: T) {
      const previous = getData<M, Key, T>(node, key);
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

      const result = attachData<M, Key, T>(node, key, next);
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    get<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): T | undefined {
      const existing = getData<M, Key, T>(node, key);
      if (existing !== undefined) return existing;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === null || created === undefined) return undefined;
      return factory.attach(node, created).data[key];
    },

    safeGet<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): T | undefined {
      // Unsafe factory: safeGet == get
      return this.get(node, ifNotExists);
    },

    safeGetResult<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): DataFactoryResult<T> {
      try {
        const value = this.safeGet(node, ifNotExists);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    },

    is<M extends DataBagNode>(
      node: M,
      mode?: "auto-init",
    ): node is DataSupplierNode<M, Key, T> {
      if (isDataSupplier<T, M, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.initOnFirstAccess === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T, M, Key>(node, key);
      }

      return false;
    },

    isPossibly<M extends DataBagNode>(node: M): boolean {
      if (isDataSupplier<T, M, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[] {
      return collectData<T, Key, Root>(root, key, visitFn);
    },

    collectNodes<Root, M extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn: VisitFn<Root>,
    ): readonly DataSupplierNode<M, Key, T>[] {
      const out: DataSupplierNode<DataBagNode, Key, T>[] = [];
      forEachData<T, Key, Root>(
        root,
        key,
        (_value, owner) => {
          out.push(owner as DataSupplierNode<DataBagNode, Key, T>);
        },
        visitFn,
      );
      return out as DataSupplierNode<M, Key, T>[];
    },

    forEach<Root>(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
      visitFn: VisitFn<Root>,
    ): void {
      forEachData<T, Key, Root>(root, key, fn, visitFn);
    },

    hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean {
      return hasAnyData<Key, Root>(root, key, visitFn);
    },

    init<M extends DataBagNode>(
      node: M,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<M, Key, T>(node, key);
      options.init(node as unknown as N, {
        factory: factory as unknown as DataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<M, Key, T>(node, key);
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

export interface SafeDataFactoryOptions<
  T,
  N extends DataBagNode = DataBagNode,
> extends DataFactoryOptions<T, N> {
  onAttachSafeParseError?: (ctx: {
    node: N;
    attemptedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  onExistingSafeParseError?: (ctx: {
    node: N;
    existingValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  onSafeGetSafeParseError?: (ctx: {
    node: N;
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
 * Create a Zod-backed data factory that never throws from safeGet / attach
 * (unless you explicitly use get() or schema.parse yourself).
 */
export function safeNodeDataFactory<
  Key extends string,
  T,
  N extends DataBagNode = DataBagNode,
>(
  key: Key,
  schema: z.ZodType<T>,
  options?: SafeDataFactoryOptions<T, N>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const events = eventBus<ScalarDataBagEvents<Key, T>>();

  const factory: DataFactory<Key, T> = {
    key,
    events,

    attach<M extends DataBagNode>(node: M, value: T) {
      const parsed = safeParseWithHandler<T>(
        node,
        value,
        schema,
        options?.onAttachSafeParseError
          ? (ctx) =>
            options.onAttachSafeParseError?.({
              node: ctx.node as N,
              attemptedValue: ctx.attemptedValue,
              error: ctx.error,
            })
          : undefined,
        "attach",
      );

      if (parsed === undefined) {
        return node as unknown as DataSupplierNode<M, Key, T>;
      }

      if (!mergeEnabled) {
        const previous = getData<M, Key, T>(node, key);
        const result = attachData<M, Key, T>(node, key, parsed);
        events.emit("assign", { key, node, previous, next: parsed });
        return result;
      }

      const existingRaw = getData<M, Key, unknown>(node, key);
      let existingParsed: T | undefined;

      if (existingRaw !== undefined) {
        existingParsed = safeParseWithHandler<T>(
          node,
          existingRaw,
          schema,
          options?.onExistingSafeParseError
            ? (ctx) =>
              options.onExistingSafeParseError?.({
                node: ctx.node as N,
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
      const result = attachData<M, Key, T>(node, key, next);
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    get<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): T | undefined {
      const raw = getData<M, Key, unknown>(node, key);
      if (raw !== undefined) return raw as T;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === null || created === undefined) return undefined;
      return factory.attach(node, created).data[key];
    },

    safeGet<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): T | undefined {
      const raw = getData<M, Key, unknown>(node, key);

      if (raw !== undefined) {
        const parsed = safeParseWithHandler<T>(
          node,
          raw,
          schema,
          options?.onSafeGetSafeParseError
            ? (ctx) =>
              options.onSafeGetSafeParseError?.({
                node: ctx.node as N,
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

      return factory.attach(node, created).data[key];
    },

    safeGetResult<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T | null | undefined,
    ): DataFactoryResult<T> {
      try {
        const raw = getData<M, Key, unknown>(node, key);
        if (raw !== undefined) {
          const parsed = safeParseWithHandler<T>(
            node,
            raw,
            schema,
            options?.onSafeGetSafeParseError
              ? (ctx) =>
                options.onSafeGetSafeParseError?.({
                  node: ctx.node as N,
                  storedValue: ctx.storedValue,
                  error: ctx.error,
                })
              : undefined,
            "safeGet",
          );

          if (parsed === undefined) {
            return {
              ok: false,
              error: new Error(
                "safeGetResult: parse failed and handler declined",
              ),
            };
          }

          return { ok: true, value: parsed };
        }

        if (!ifNotExists) return { ok: true, value: undefined };
        const created = ifNotExists(node);
        if (created === null || created === undefined) {
          return { ok: true, value: undefined };
        }

        const attached = factory.attach(node, created).data[key];
        return { ok: true, value: attached };
      } catch (error) {
        return { ok: false, error };
      }
    },

    is<M extends DataBagNode>(
      node: M,
      mode?: "auto-init",
    ): node is DataSupplierNode<M, Key, T> {
      if (isDataSupplier<T, M, Key>(node, key)) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.initOnFirstAccess === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit) {
        factory.init(node, { onFirstAccessAuto: true });
        return isDataSupplier<T, M, Key>(node, key);
      }

      return false;
    },

    isPossibly<M extends DataBagNode>(node: M): boolean {
      if (isDataSupplier<T, M, Key>(node, key)) return true;
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[] {
      return collectData<T, Key, Root>(root, key, visitFn);
    },

    collectNodes<Root, M extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn: VisitFn<Root>,
    ): readonly DataSupplierNode<M, Key, T>[] {
      const out: DataSupplierNode<DataBagNode, Key, T>[] = [];
      forEachData<T, Key, Root>(
        root,
        key,
        (_value, owner) => {
          out.push(owner as DataSupplierNode<DataBagNode, Key, T>);
        },
        visitFn,
      );
      return out as DataSupplierNode<M, Key, T>[];
    },

    forEach<Root>(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
      visitFn: VisitFn<Root>,
    ): void {
      forEachData<T, Key, Root>(root, key, fn, visitFn);
    },

    hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean {
      return hasAnyData<Key, Root>(root, key, visitFn);
    },

    init<M extends DataBagNode>(
      node: M,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const previous = getData<M, Key, T>(node, key);
      options.init(node as unknown as N, {
        factory: factory as unknown as DataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const next = getData<M, Key, T>(node, key);
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

export interface ArrayDataFactoryOptions<
  N extends DataBagNode = DataBagNode,
> {
  merge?: boolean;
  init?: (
    node: N,
    ctx: {
      factory: ArrayDataFactory<string, unknown>;
      onFirstAccessAuto?: boolean;
    },
  ) => void;
  initOnFirstAccess?: boolean;
  autoInitOnIs?: boolean;
}

export type ArrayDataFactoryResult<T> =
  | { ok: true; value: readonly T[] }
  | { ok: false; error: unknown };

export interface ArrayDataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;
  readonly events: ReturnType<typeof eventBus<ArrayDataBagEvents<Key, T>>>;

  add<N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): DataSupplierNode<N, Key, T[]>;

  /**
   * Pure variant: does not mutate original node.
   */
  withAdded<N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): DataSupplierNode<N, Key, T[]>;

  get<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  safeGet<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  safeGetResult<N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): ArrayDataFactoryResult<T>;

  is<N extends DataBagNode>(
    node: N,
  ): node is DataSupplierNode<N, Key, T[]>;
  is<N extends DataBagNode>(
    node: N,
    mode: "auto-init",
  ): node is DataSupplierNode<N, Key, T[]>;

  isPossibly<N extends DataBagNode>(node: N): boolean;

  collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[];

  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
    visitFn: VisitFn<Root>,
  ): readonly DataSupplierNode<N, Key, T[]>[];

  forEach<Root>(
    root: Root,
    fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
    visitFn: VisitFn<Root>,
  ): void;

  hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean;

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
  N extends DataBagNode = DataBagNode,
>(
  key: Key,
  options?: ArrayDataFactoryOptions<N>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const events = eventBus<ArrayDataBagEvents<Key, T>>();

  const factory: ArrayDataFactory<Key, T> = {
    key,
    events,

    add<M extends DataBagNode>(node: M, ...items: readonly T[]) {
      const bag = ensureDataRecord(node);
      const existingRaw = merge ? (bag[key] as T[] | undefined) : undefined;
      const previous = existingRaw ?? undefined;
      const base = Array.isArray(existingRaw) ? existingRaw : [];
      const next = base.concat(items);
      bag[key] = next;
      const result = node as unknown as DataSupplierNode<M, Key, T[]>;
      events.emit("add", { key, node, previous, added: items, next });
      events.emit("assign", { key, node, previous, next });
      return result;
    },

    withAdded<M extends DataBagNode>(
      node: M,
      ...items: readonly T[]
    ): DataSupplierNode<M, Key, T[]> {
      const cloned = { ...node } as M;
      return factory.add(cloned, ...items);
    },

    get<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): T[] {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key])) {
        return bag[key] as T[];
      }

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      const result = factory.add(node, ...created);
      return result.data[key];
    },

    safeGet<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): T[] {
      return this.get(node, ifNotExists);
    },

    safeGetResult<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): ArrayDataFactoryResult<T> {
      try {
        const value = this.safeGet(node, ifNotExists);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    },

    is<M extends DataBagNode>(
      node: M,
      mode?: "auto-init",
    ): node is DataSupplierNode<M, Key, T[]> {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key])) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        const after = dataRecordOrUndefined(node);
        return !!after && Array.isArray(after[key]);
      }

      return false;
    },

    isPossibly<M extends DataBagNode>(node: M): boolean {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key]) && (bag[key] as T[]).length > 0) {
        return true;
      }
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[] {
      const buckets = collectData<T[], Key, Root>(root, key, visitFn);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<Root, M extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn: VisitFn<Root>,
    ): readonly DataSupplierNode<M, Key, T[]>[] {
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

      return out as DataSupplierNode<M, Key, T[]>[];
    },

    forEach<Root>(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
      visitFn: VisitFn<Root>,
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

    hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean {
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

    init<M extends DataBagNode>(
      node: M,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const bagBefore = dataRecordOrUndefined(node);
      const previous = bagBefore && Array.isArray(bagBefore[key])
        ? (bagBefore[key] as T[])
        : undefined;
      options.init(node as unknown as N, {
        factory: factory as unknown as ArrayDataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const bagAfter = dataRecordOrUndefined(node);
      const next = bagAfter && Array.isArray(bagAfter[key])
        ? (bagAfter[key] as T[])
        : undefined;
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

export interface SafeArrayDataFactoryOptions<
  T,
  N extends DataBagNode = DataBagNode,
> extends ArrayDataFactoryOptions<N> {
  onAddSafeParseError?: (ctx: {
    node: N;
    attemptedItems: readonly unknown[];
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  onExistingSafeParseError?: (ctx: {
    node: N;
    existingValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  onSafeGetSafeParseError?: (ctx: {
    node: N;
    storedValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;
}

/**
 * Create a Zod-backed array-valued data factory that never throws from
 * safeGet/add unless you explicitly use get() or schema.parse yourself.
 */
export function safeNodeArrayDataFactory<
  Key extends string,
  T,
  N extends DataBagNode = DataBagNode,
>(
  key: Key,
  itemSchema: z.ZodType<T>,
  options?: SafeArrayDataFactoryOptions<T, N>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const arraySchema = z.array(itemSchema);
  const events = eventBus<ArrayDataBagEvents<Key, T>>();

  const factory: ArrayDataFactory<Key, T> = {
    key,
    events,

    add<M extends DataBagNode>(node: M, ...items: readonly T[]) {
      const parsedItems = ((): T[] | undefined => {
        const res = arraySchema.safeParse(items);
        if (res.success) return res.data;

        if (!options?.onAddSafeParseError) return undefined;
        const replacement = options.onAddSafeParseError({
          node: node as unknown as N,
          attemptedItems: items,
          error: res.error,
        });

        if (!replacement) return undefined;
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : undefined;
      })();

      if (!parsedItems) {
        return node as unknown as DataSupplierNode<M, Key, T[]>;
      }

      const bag = ensureDataRecord(node);
      const existingRaw = merge ? bag[key] : undefined;

      const existingParsed = ((): T[] | undefined => {
        if (existingRaw === undefined) return undefined;

        const res = arraySchema.safeParse(existingRaw);
        if (res.success) return res.data;

        if (!options?.onExistingSafeParseError) return undefined;
        const replacement = options.onExistingSafeParseError({
          node: node as unknown as N,
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
      bag[key] = next;

      const result = node as unknown as DataSupplierNode<M, Key, T[]>;
      events.emit("add", { key, node, previous, added: parsedItems, next });
      events.emit("assign", { key, node, previous, next });

      return result;
    },

    withAdded<M extends DataBagNode>(
      node: M,
      ...items: readonly T[]
    ): DataSupplierNode<M, Key, T[]> {
      const cloned = { ...node } as M;
      return factory.add(cloned, ...items);
    },

    get<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): T[] {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key])) {
        return bag[key] as T[];
      }

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      const result = factory.add(node, ...created);
      return result.data[key];
    },

    safeGet<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): T[] {
      const bag = dataRecordOrUndefined(node);
      if (bag && bag[key] !== undefined) {
        const raw = bag[key];
        const res = arraySchema.safeParse(raw);
        if (res.success) return res.data;

        if (!options?.onSafeGetSafeParseError) return [];
        const replacement = options.onSafeGetSafeParseError({
          node: node as unknown as N,
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
      const result = factory.add(node, ...created);
      return result.data[key];
    },

    safeGetResult<M extends DataBagNode>(
      node: M,
      ifNotExists?: (node: M) => T[],
    ): ArrayDataFactoryResult<T> {
      try {
        const value = this.safeGet(node, ifNotExists);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error };
      }
    },

    is<M extends DataBagNode>(
      node: M,
      mode?: "auto-init",
    ): node is DataSupplierNode<M, Key, T[]> {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key])) return true;

      const shouldAutoInit =
        (mode === "auto-init" || options?.autoInitOnIs === true) &&
        options?.init &&
        options?.initOnFirstAccess;

      if (shouldAutoInit && options?.init) {
        factory.init(node, { onFirstAccessAuto: true });
        const after = dataRecordOrUndefined(node);
        return !!after && Array.isArray(after[key]);
      }

      return false;
    },

    isPossibly<M extends DataBagNode>(node: M): boolean {
      const bag = dataRecordOrUndefined(node);
      if (bag && Array.isArray(bag[key]) && (bag[key] as T[]).length > 0) {
        return true;
      }
      return !!(options?.init && options?.initOnFirstAccess);
    },

    collect<Root>(root: Root, visitFn: VisitFn<Root>): readonly T[] {
      const buckets = collectData<T[], Key, Root>(root, key, visitFn);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<Root, M extends DataBagNode = DataBagNode>(
      root: Root,
      visitFn: VisitFn<Root>,
    ): readonly DataSupplierNode<M, Key, T[]>[] {
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

      return out as DataSupplierNode<M, Key, T[]>[];
    },

    forEach<Root>(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<DataBagNode, Key, T[]>) => void,
      visitFn: VisitFn<Root>,
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

    hasAny<Root>(root: Root, visitFn: VisitFn<Root>): boolean {
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

    init<M extends DataBagNode>(
      node: M,
      ctx?: { onFirstAccessAuto?: boolean },
    ): void {
      if (!options?.init) return;
      const bagBefore = dataRecordOrUndefined(node);
      const previous = bagBefore && Array.isArray(bagBefore[key])
        ? (bagBefore[key] as T[])
        : undefined;
      options.init(node as unknown as N, {
        factory: factory as unknown as ArrayDataFactory<string, unknown>,
        onFirstAccessAuto: ctx?.onFirstAccessAuto,
      });
      const bagAfter = dataRecordOrUndefined(node);
      const next = bagAfter && Array.isArray(bagAfter[key])
        ? (bagAfter[key] as T[])
        : undefined;
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
 */
export function defineNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: DataFactoryOptions<T, N>,
  ): NodeDataDef<Key, T, N> => ({
    key,
    factory: nodeDataFactory<Key, T, N>(key, options),
  });
}

/**
 * Zod-backed version.
 */
export function defineSafeNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    schema: z.ZodType<T>,
    options?: SafeDataFactoryOptions<T, N>,
  ): NodeDataDef<Key, T, N> => ({
    key,
    factory: safeNodeDataFactory<Key, T, N>(key, schema, options),
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
 * Infer the enriched node type from a definition or factory that exposes
 * a type-guard-shaped `is` method.
 */
export type NodeWithData<Def> = Def extends {
  factory: {
    is(node: unknown, ...args: readonly unknown[]): node is infer WithData;
  };
} ? WithData
  : never;

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
 */
export function defineNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: ArrayDataFactoryOptions<N>,
  ): NodeArrayDataDef<Key, T, N> => ({
    key,
    factory: nodeArrayDataFactory<Key, T, N>(key, options),
  });
}

/**
 * Zod-backed array-valued definition.
 */
export function defineSafeNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    itemSchema: z.ZodType<T>,
    options?: SafeArrayDataFactoryOptions<T, N>,
  ): NodeArrayDataDef<Key, T, N> => ({
    key,
    factory: safeNodeArrayDataFactory<Key, T, N>(key, itemSchema, options),
  });
}
