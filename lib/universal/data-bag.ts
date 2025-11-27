// data-bag.ts
//
// Generalized, type-safe utilities for attaching arbitrary strongly-typed
// data structures onto "nodes" that expose an optional `data` bag, with
// optional Zod validation and a typed event bus.
//
// - Core primitives: ensureData, attachData, getData, isDataSupplier,
//   collectData, forEachData, hasAnyData
// - Factories (scalar/object):
//   - nodeDataFactory() / safeNodeDataFactory()
//   - defineNodeData() / defineSafeNodeData()
// - Factories (array-valued):
//   - nodeArrayDataFactory() / safeNodeArrayDataFactory()
//   - defineNodeArrayData() / defineSafeNodeArrayData()
//
// Traversal is fully generic via a caller-supplied `visitFn`, so this module
// has no direct dependency on mdast/unist. In an mdast/unist setting you can
// pass a thin wrapper around `unist-util-visit`:
//
//   const visitFn: VisitFn<Root> = (root, visitor) => {
//     visit(root, (node) => visitor(node as unknown as DataBagNode));
//   };
//
// and feed that into factory options.
//
// Events:
// - Scalar factories emit: "assign", "init", "init-auto"
// - Array factories emit:  "add", "assign", "init", "init-auto"
// via the shared `eventBus` from ./event-bus.ts.
//
import { z } from "@zod/zod";
import { eventBus } from "./event-bus.ts";

/* -------------------------------------------------------------------------- */
/* Core node & traversal types                                                */
/* -------------------------------------------------------------------------- */

/**
 * Minimal "node" shape that can carry a data bag.
 *
 * This is intentionally loose, so it can be used with mdast, unist, or any
 * other AST-like structure that has a `data` slot.
 */
export interface DataBagNode {
  data?: Record<string, unknown>;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

/**
 * Generic traversal function:
 *   - `Root` is whatever your tree root type is.
 *   - `visitor` receives each node as a `DataBagNode`.
 */
export type VisitFn<Root = unknown> = (
  root: Root,
  visitor: (node: DataBagNode) => void,
) => void;

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensure `node.data` exists and return it as a mutable bag.
 */
export function ensureData<N extends DataBagNode>(
  node: N,
): Record<string, unknown> {
  const n = node as DataBagNode;
  if (!n.data) n.data = {};
  return n.data;
}

/**
 * A node that supplies some named data bag, like:
 *
 *   node.data[key] = T
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
  return node as DataSupplierNode<N, Key, T>;
}

/**
 * Retrieve typed data from a node. Returns undefined if missing.
 *
 * If a Zod schema is supplied, the value is validated before returning.
 * Throws if validation fails.
 *
 * NOTE: This is the low-level primitive and *can* throw; safe factories
 * wrap validation with safeParse and user-provided callbacks instead of
 * throwing.
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
  const data = (node as DataBagNode).data;
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
  const data = (node as DataBagNode).data;
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
  visitFn: VisitFn<Root>,
): readonly T[] {
  const out: T[] = [];
  visitFn(root, (node) => {
    if (isDataSupplier<T, DataBagNode, Key>(node, key)) {
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
  visitFn: VisitFn<Root>,
  fn: (value: T, owner: DataSupplierNode<DataBagNode, Key, T>) => void,
): void {
  visitFn(root, (node) => {
    if (isDataSupplier<T, DataBagNode, Key>(node, key)) {
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
  return node as DataSupplierNode<N, Key, T>;
}

/* -------------------------------------------------------------------------- */
/* Event maps for factories                                                   */
/* -------------------------------------------------------------------------- */

export type DataBagScalarEvents<
  Key extends string,
  V,
> = {
  /**
   * A value for this key was assigned (including merge cases).
   */
  assign: {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V;
  };

  /**
   * Explicit initialization via factory.init(node, …).
   */
  init: {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V | undefined;
  };

  /**
   * Implicit initialization via initOnFirstAccess.
   */
  "init-auto": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: V | undefined;
    readonly next: V | undefined;
  };
};

export type DataBagArrayEvents<
  Key extends string,
  V,
> = {
  /**
   * One or more items were added/replaced.
   */
  add: {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly V[] | undefined;
    readonly added: readonly V[];
    readonly next: readonly V[];
  };

  /**
   * Full array assignment (e.g., from get(ifNotExists)).
   */
  assign: {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly V[] | undefined;
    readonly next: readonly V[];
  };

  init: {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly V[] | undefined;
    readonly next: readonly V[] | undefined;
  };

  "init-auto": {
    readonly key: Key;
    readonly node: DataBagNode;
    readonly previous: readonly V[] | undefined;
    readonly next: readonly V[] | undefined;
  };
};

export type DataBagScalarEventBus<Key extends string, V> = ReturnType<
  typeof eventBus<DataBagScalarEvents<Key, V>>
>;

export type DataBagArrayEventBus<Key extends string, V> = ReturnType<
  typeof eventBus<DataBagArrayEvents<Key, V>>
>;

/* -------------------------------------------------------------------------- */
/* Scalar/object Data factories (unsafe, no Zod)                              */
/* -------------------------------------------------------------------------- */

export interface DataFactoryOptions<
  Key extends string,
  T,
> {
  /**
   * If true, attach() will deep-merge new values with existing values when both
   * are plain objects. For non-plain objects, attach() falls back to overwrite.
   */
  readonly merge?: boolean;

  /**
   * Generic tree traversal function. If omitted, collect/forEach/hasAny will
   * effectively become no-ops.
   */
  readonly visitFn?: VisitFn<unknown>;

  /**
   * Init callback invoked by factory.init(...) and (optionally) automatically
   * on first access if initOnFirstAccess is true.
   *
   * - `onFirstAccessAuto === false` when called via factory.init(node)
   * - `onFirstAccessAuto === true`  when invoked automatically on first access
   */
  readonly init?: (
    node: DataBagNode,
    factory: DataFactory<Key, T>,
    onFirstAccessAuto: boolean,
  ) => void;

  /**
   * If true and `init` is defined, the factory will automatically call
   * init(node, factory, true) the first time a node is accessed (get/safeGet/
   * attach/add) and has no data for this key yet.
   */
  readonly initOnFirstAccess?: boolean;
}

export interface DataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  /**
   * Typed event bus for this key/value pair.
   *
   * Events:
   * - "assign"    → { key, node, previous, next }
   * - "init"      → { key, node, previous, next }
   * - "init-auto" → { key, node, previous, next }
   */
  readonly events: DataBagScalarEventBus<Key, T>;

  /**
   * Attach a value (overwriting or merging based on options).
   */
  attach<N extends DataBagNode>(node: N, value: T): N;

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
   * Explicit initializer. Usually called internally when `initOnFirstAccess`
   * is enabled, but can be invoked manually as well.
   */
  init<N extends DataBagNode>(
    node: N,
    opts?: { onFirstAccessAuto?: boolean },
  ): void;

  /**
   * Type guard for nodes that have the key set.
   */
  is<N extends DataBagNode>(node: N): node is N & { data: { [K in Key]: T } };

  collect<Root>(root: Root): readonly T[];

  /**
   * Like collect(), but returns the owning nodes instead of the values.
   */
  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[];

  forEach<Root>(
    root: Root,
    fn: (value: T, owner: DataBagNode) => void,
  ): void;

  hasAny<Root>(root: Root): boolean;
}

/**
 * Create a data factory bound to a specific key (no Zod validation).
 */
export function nodeDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  options?: DataFactoryOptions<Key, T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const defaultVisitFn = options?.visitFn;

  const events = eventBus<DataBagScalarEvents<Key, T>>();

  // deno-lint-ignore prefer-const
  let factory!: DataFactory<Key, T>;

  const emitInit = (
    node: DataBagNode,
    previous: T | undefined,
    next: T | undefined,
    auto: boolean,
  ) => {
    events.emit(auto ? "init-auto" : "init", {
      key,
      node,
      previous,
      next,
    });
  };

  const emitAssign = (
    node: DataBagNode,
    previous: T | undefined,
    next: T,
  ) => {
    events.emit("assign", { key, node, previous, next });
  };

  const runInit = (node: DataBagNode, auto: boolean) => {
    if (!options?.init) return;

    const data = ensureData(node);
    const previous = data[key] as T | undefined;

    options.init(node, factory, auto);

    const after = ensureData(node)[key] as T | undefined;
    if (previous !== after) {
      emitInit(node, previous, after, auto);
    }
  };

  const maybeAutoInit = (node: DataBagNode) => {
    if (!options?.initOnFirstAccess || !options.init) return;
    const data = ensureData(node);
    if (data[key] !== undefined) return;
    runInit(node, true);
  };

  const attach = <N extends DataBagNode>(node: N, value: T): N => {
    maybeAutoInit(node);

    const data = ensureData(node);
    const previous = data[key] as T | undefined;

    let next: T;
    if (
      mergeEnabled &&
      previous !== undefined &&
      isPlainObject(previous) &&
      isPlainObject(value)
    ) {
      next = deepMerge(previous, value as Partial<T>);
    } else {
      next = value;
    }

    (data as Record<string, unknown>)[key] = next;
    emitAssign(node, previous, next);
    return node;
  };

  const get = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined => {
    maybeAutoInit(node);

    const data = (node as DataBagNode).data;
    const existing = data ? (data[key] as T | undefined) : undefined;
    if (existing !== undefined) return existing;

    if (!ifNotExists) return undefined;
    const created = ifNotExists(node);
    if (created === null || created === undefined) return undefined;

    const d = ensureData(node);
    const previous = d[key] as T | undefined;
    (d as Record<string, unknown>)[key] = created;
    emitAssign(node, previous, created);
    return created;
  };

  const safeGet = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined => {
    // Unsafe factory: safeGet == get
    return get(node, ifNotExists);
  };

  const is = <N extends DataBagNode>(
    node: N,
  ): node is N & { data: { [K in Key]: T } } => {
    const data = (node as DataBagNode).data;
    return !!data && key in data;
  };

  const collect = <Root>(root: Root): readonly T[] => {
    if (!defaultVisitFn) return [];
    const visit = defaultVisitFn as VisitFn<Root>;
    return collectData<T, Key, Root>(root, key, visit);
  };

  const collectNodes = <Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[] => {
    const out: N[] = [];
    if (!defaultVisitFn) return out;
    const visit = defaultVisitFn as VisitFn<Root>;
    visit(root, (node) => {
      if (is(node)) out.push(node as unknown as N);
    });
    return out;
  };

  const forEach = <Root>(
    root: Root,
    fn: (value: T, owner: DataBagNode) => void,
  ): void => {
    if (!defaultVisitFn) return;
    const visit = defaultVisitFn as VisitFn<Root>;
    forEachData<T, Key, Root>(
      root,
      key,
      visit,
      (value, owner) => fn(value, owner),
    );
  };

  const hasAny = <Root>(root: Root): boolean => {
    if (!defaultVisitFn) return false;
    const visit = defaultVisitFn as VisitFn<Root>;
    return hasAnyData<Key, Root>(root, key, visit);
  };

  factory = {
    key,
    events,
    attach,
    get,
    safeGet,
    init<N extends DataBagNode>(
      node: N,
      opts?: { onFirstAccessAuto?: boolean },
    ) {
      runInit(node, !!opts?.onFirstAccessAuto);
    },
    is,
    collect,
    collectNodes,
    forEach,
    hasAny,
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Array-valued factories (unsafe, no Zod)                                    */
/* -------------------------------------------------------------------------- */

export interface ArrayDataFactoryOptions<
  Key extends string,
  T,
> {
  /**
   * If true (default), add() appends to any existing array.
   * If false, add() replaces the array with the new items.
   */
  readonly merge?: boolean;

  readonly visitFn?: VisitFn<unknown>;

  readonly init?: (
    node: DataBagNode,
    factory: ArrayDataFactory<Key, T>,
    onFirstAccessAuto: boolean,
  ) => void;

  readonly initOnFirstAccess?: boolean;
}

export interface ArrayDataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  /**
   * Typed event bus for array-valued data:
   *
   * - "add"       → { key, node, previous, added, next }
   * - "assign"    → { key, node, previous, next }
   * - "init"      → { key, node, previous, next }
   * - "init-auto" → { key, node, previous, next }
   */
  readonly events: DataBagArrayEventBus<Key, T>;

  // Append or replace items in the per-node array (depending on merge option)
  add<N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): N;

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
  ): node is N & { data: { [K in Key]: T[] } };

  // Flatten all arrays from all nodes into a single array
  collect<Root>(root: Root): readonly T[];

  /**
   * Like collect(), but returns the owning nodes (one per node) instead
   * of individual items. Nodes with empty or non-array buckets are skipped.
   */
  collectNodes<Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[];

  // Visit each individual item together with its owning node
  forEach<Root>(
    root: Root,
    fn: (item: T, owner: DataBagNode) => void,
  ): void;

  // True if any node has a non-empty array for this key
  hasAny<Root>(root: Root): boolean;

  /**
   * Explicit initializer (array-valued).
   */
  init<N extends DataBagNode>(
    node: N,
    opts?: { onFirstAccessAuto?: boolean },
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
  options?: ArrayDataFactoryOptions<Key, T>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const defaultVisitFn = options?.visitFn;

  const events = eventBus<DataBagArrayEvents<Key, T>>();

  // deno-lint-ignore prefer-const
  let factory!: ArrayDataFactory<Key, T>;

  const emitInit = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    next: readonly T[] | undefined,
    auto: boolean,
  ) => {
    events.emit(auto ? "init-auto" : "init", {
      key,
      node,
      previous,
      next,
    });
  };

  const emitAssign = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    next: readonly T[],
  ) => {
    events.emit("assign", { key, node, previous, next });
  };

  const emitAdd = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    added: readonly T[],
    next: readonly T[],
  ) => {
    events.emit("add", { key, node, previous, added, next });
  };

  const runInit = (node: DataBagNode, auto: boolean) => {
    if (!options?.init) return;
    const data = ensureData(node);
    const previous = data[key] as T[] | undefined;

    options.init(node, factory, auto);

    const after = ensureData(node)[key] as T[] | undefined;
    if (previous !== after) {
      emitInit(node, previous, after, auto);
    }
  };

  const maybeAutoInit = (node: DataBagNode) => {
    if (!options?.initOnFirstAccess || !options.init) return;
    const data = ensureData(node);
    if (data[key] !== undefined) return;
    runInit(node, true);
  };

  const add = <N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): N => {
    maybeAutoInit(node);

    const data = ensureData(node);
    const previous = (data[key] as T[] | undefined) ?? [];

    const base = merge ? previous : [];
    const next = base.concat(items);
    (data as Record<string, unknown>)[key] = next;

    emitAdd(
      node,
      previous.length ? previous : undefined,
      items,
      next,
    );
    return node;
  };

  const get = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[] => {
    maybeAutoInit(node);

    const data = (node as DataBagNode).data;
    const existing = data ? (data[key] as T[] | undefined) : undefined;
    if (existing !== undefined) return existing;

    if (!ifNotExists) return [];
    const created = ifNotExists(node);
    if (!created) return [];

    const d = ensureData(node);
    const previous = d[key] as T[] | undefined;
    (d as Record<string, unknown>)[key] = created;
    emitAssign(node, previous, created);
    return created;
  };

  const safeGet = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[] => {
    // Unsafe factory: safeGet == get
    return get(node, ifNotExists);
  };

  const is = <N extends DataBagNode>(
    node: N,
  ): node is N & { data: { [K in Key]: T[] } } => {
    const data = (node as DataBagNode).data;
    return !!data && key in data && Array.isArray(data[key]);
  };

  const collect = <Root>(root: Root): readonly T[] => {
    if (!defaultVisitFn) return [];
    const visit = defaultVisitFn as VisitFn<Root>;
    const buckets = collectData<T[], Key, Root>(root, key, visit);
    const out: T[] = [];
    for (const bucket of buckets) {
      if (Array.isArray(bucket)) out.push(...bucket);
    }
    return out;
  };

  const collectNodes = <Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[] => {
    const out: N[] = [];
    if (!defaultVisitFn) return out;
    const visit = defaultVisitFn as VisitFn<Root>;
    visit(root, (node) => {
      if (!is(node)) return;
      const arr = (node.data as Record<Key, unknown>)[key];
      if (Array.isArray(arr) && arr.length > 0) {
        out.push(node as unknown as N);
      }
    });
    return out;
  };

  const forEach = <Root>(
    root: Root,
    fn: (item: T, owner: DataBagNode) => void,
  ): void => {
    if (!defaultVisitFn) return;
    const visit = defaultVisitFn as VisitFn<Root>;
    forEachData<T[], Key, Root>(
      root,
      key,
      visit,
      (bucket, owner) => {
        if (!Array.isArray(bucket)) return;
        for (const item of bucket) {
          fn(item, owner);
        }
      },
    );
  };

  const hasAny = <Root>(root: Root): boolean => {
    if (!defaultVisitFn) return false;
    const visit = defaultVisitFn as VisitFn<Root>;
    let found = false;
    visit(root, (node) => {
      if (found) return;
      if (!is(node)) return;
      const arr = (node.data as Record<Key, unknown>)[key];
      if (Array.isArray(arr) && arr.length > 0) found = true;
    });
    return found;
  };

  factory = {
    key,
    events,
    add,
    get,
    safeGet,
    is,
    collect,
    collectNodes,
    forEach,
    hasAny,
    init<N extends DataBagNode>(
      node: N,
      opts?: { onFirstAccessAuto?: boolean },
    ) {
      runInit(node, !!opts?.onFirstAccessAuto);
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Safe factories (Zod-backed, callback-driven error handling)                */
/* -------------------------------------------------------------------------- */

export interface SafeDataFactoryOptions<
  Key extends string,
  T,
> extends DataFactoryOptions<Key, T> {
  /**
   * Called when attach() fails safeParse on the new value.
   *
   * Return:
   * - T: replacement value which will then be attached (and validated again).
   * - null | undefined: do nothing (value is not stored).
   */
  readonly onAttachSafeParseError?: (ctx: {
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
  readonly onExistingSafeParseError?: (ctx: {
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
  readonly onSafeGetSafeParseError?: (ctx: {
    node: DataBagNode;
    storedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;
}

export interface SafeArrayDataFactoryOptions<
  Key extends string,
  T,
> extends ArrayDataFactoryOptions<Key, T> {
  /**
   * Called when add() fails safeParse on the incoming items.
   *
   * Return:
   * - T[]: replacement array of items to use instead.
   * - null | undefined: do nothing (no items stored).
   */
  readonly onAddSafeParseError?: (ctx: {
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
  readonly onExistingSafeParseError?: (ctx: {
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
  readonly onSafeGetSafeParseError?: (ctx: {
    node: DataBagNode;
    storedValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;
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
  kind: "attach" | "existing" | "safeGet",
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
  options?: SafeDataFactoryOptions<Key, T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;
  const defaultVisitFn = options?.visitFn;

  const events = eventBus<DataBagScalarEvents<Key, T>>();

  // deno-lint-ignore prefer-const
  let factory!: DataFactory<Key, T>;

  const emitInit = (
    node: DataBagNode,
    previous: T | undefined,
    next: T | undefined,
    auto: boolean,
  ) => {
    events.emit(auto ? "init-auto" : "init", {
      key,
      node,
      previous,
      next,
    });
  };

  const emitAssign = (
    node: DataBagNode,
    previous: T | undefined,
    next: T,
  ) => {
    events.emit("assign", { key, node, previous, next });
  };

  const runInit = (node: DataBagNode, auto: boolean) => {
    if (!options?.init) return;

    const data = ensureData(node);
    const previousRaw = data[key];
    const previous = previousRaw === undefined
      ? undefined
      : safeParseWithHandler(
        node,
        previousRaw,
        schema,
        options.onExistingSafeParseError
          ? (ctx) =>
            options.onExistingSafeParseError?.({
              node: ctx.node,
              existingValue: ctx.existingValue,
              error: ctx.error,
            })
          : undefined,
        "existing",
      );

    options.init(node, factory, auto);

    const afterRaw = ensureData(node)[key];
    const after = afterRaw === undefined ? undefined : safeParseWithHandler(
      node,
      afterRaw,
      schema,
      options.onExistingSafeParseError
        ? (ctx) =>
          options.onExistingSafeParseError?.({
            node: ctx.node,
            existingValue: ctx.existingValue,
            error: ctx.error,
          })
        : undefined,
      "existing",
    );

    if (previous !== after) {
      emitInit(node, previous, after, auto);
    }
  };

  const maybeAutoInit = (node: DataBagNode) => {
    if (!options?.initOnFirstAccess || !options.init) return;
    const data = ensureData(node);
    if (data[key] !== undefined) return;
    runInit(node, true);
  };

  const attach = <N extends DataBagNode>(node: N, value: T): N => {
    maybeAutoInit(node);

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
      return node;
    }

    const data = ensureData(node);
    const existingRaw = data[key];
    let existingParsed: T | undefined;

    if (mergeEnabled && existingRaw !== undefined) {
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
      mergeEnabled &&
      existingParsed !== undefined &&
      isPlainObject(existingParsed) &&
      isPlainObject(parsed)
    ) {
      next = deepMerge(existingParsed, parsed as Partial<T>);
    } else {
      next = parsed;
    }

    (data as Record<string, unknown>)[key] = next;
    emitAssign(node, existingParsed, next);
    return node;
  };

  const get = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined => {
    maybeAutoInit(node);

    // Raw, unvalidated access: no Zod, no callbacks.
    const raw = getData<unknown, N, Key>(node, key);
    if (raw !== undefined) return raw as T;

    if (!ifNotExists) return undefined;
    const created = ifNotExists(node);
    if (created === undefined || created === null) return undefined;
    attach(node, created);
    return created;
  };

  const safeGet = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined => {
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
    if (created === undefined || created === null) return undefined;

    // We trust the provided default and attach it directly (validated via attach).
    attach(node, created);
    return created;
  };

  const is = <N extends DataBagNode>(
    node: N,
  ): node is N & { data: { [K in Key]: T } } => {
    const data = (node as DataBagNode).data;
    return !!data && key in data;
  };

  const collect = <Root>(root: Root): readonly T[] => {
    if (!defaultVisitFn) return [];
    const visit = defaultVisitFn as VisitFn<Root>;
    return collectData<T, Key, Root>(root, key, visit);
  };

  const collectNodes = <Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[] => {
    const out: N[] = [];
    if (!defaultVisitFn) return out;
    const visit = defaultVisitFn as VisitFn<Root>;
    visit(root, (node) => {
      if (is(node)) out.push(node as unknown as N);
    });
    return out;
  };

  const forEach = <Root>(
    root: Root,
    fn: (value: T, owner: DataBagNode) => void,
  ): void => {
    if (!defaultVisitFn) return;
    const visit = defaultVisitFn as VisitFn<Root>;
    forEachData<T, Key, Root>(
      root,
      key,
      visit,
      (value, owner) => fn(value, owner),
    );
  };

  const hasAny = <Root>(root: Root): boolean => {
    if (!defaultVisitFn) return false;
    const visit = defaultVisitFn as VisitFn<Root>;
    return hasAnyData<Key, Root>(root, key, visit);
  };

  factory = {
    key,
    events,
    attach,
    get,
    safeGet,
    init<N extends DataBagNode>(
      node: N,
      opts?: { onFirstAccessAuto?: boolean },
    ) {
      runInit(node, !!opts?.onFirstAccessAuto);
    },
    is,
    collect,
    collectNodes,
    forEach,
    hasAny,
  };

  return factory;
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
  options?: SafeArrayDataFactoryOptions<Key, T>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const defaultVisitFn = options?.visitFn;
  const arraySchema = z.array(itemSchema);

  const events = eventBus<DataBagArrayEvents<Key, T>>();

  // deno-lint-ignore prefer-const
  let factory!: ArrayDataFactory<Key, T>;

  const emitInit = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    next: readonly T[] | undefined,
    auto: boolean,
  ) => {
    events.emit(auto ? "init-auto" : "init", {
      key,
      node,
      previous,
      next,
    });
  };

  const emitAssign = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    next: readonly T[],
  ) => {
    events.emit("assign", { key, node, previous, next });
  };

  const emitAdd = (
    node: DataBagNode,
    previous: readonly T[] | undefined,
    added: readonly T[],
    next: readonly T[],
  ) => {
    events.emit("add", { key, node, previous, added, next });
  };

  const runInit = (node: DataBagNode, auto: boolean) => {
    if (!options?.init) return;
    const data = ensureData(node);
    const previousRaw = data[key];
    let previous: T[] | undefined;

    if (previousRaw !== undefined) {
      const res = arraySchema.safeParse(previousRaw);
      if (res.success) {
        previous = res.data;
      } else if (options.onExistingSafeParseError) {
        const replacement = options.onExistingSafeParseError({
          node,
          existingValue: previousRaw,
          error: res.error,
        });
        if (replacement) {
          const again = arraySchema.safeParse(replacement);
          if (again.success) previous = again.data;
        }
      }
    }

    options.init(node, factory, auto);

    const afterRaw = ensureData(node)[key];
    let after: T[] | undefined;

    if (afterRaw !== undefined) {
      const res = arraySchema.safeParse(afterRaw);
      if (res.success) {
        after = res.data;
      } else if (options.onExistingSafeParseError) {
        const replacement = options.onExistingSafeParseError({
          node,
          existingValue: afterRaw,
          error: res.error,
        });
        if (replacement) {
          const again = arraySchema.safeParse(replacement);
          if (again.success) after = again.data;
        }
      }
    }

    if (previous !== after) {
      emitInit(node, previous, after, auto);
    }
  };

  const maybeAutoInit = (node: DataBagNode) => {
    if (!options?.initOnFirstAccess || !options.init) return;
    const data = ensureData(node);
    if (data[key] !== undefined) return;
    runInit(node, true);
  };

  const add = <N extends DataBagNode>(
    node: N,
    ...items: readonly T[]
  ): N => {
    maybeAutoInit(node);

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
      return node;
    }

    const data = ensureData(node);
    const existingRaw = merge ? data[key] : undefined;

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

    const base: T[] = existingParsed ?? [];
    const next = base.concat(parsedItems);
    (data as Record<string, unknown>)[key] = next;

    emitAdd(
      node,
      existingParsed ?? undefined,
      parsedItems,
      next,
    );
    return node;
  };

  const get = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[] => {
    maybeAutoInit(node);

    const raw = getData<unknown, N, Key>(node, key);
    if (raw !== undefined) return raw as T[];

    if (!ifNotExists) return [];
    const created = ifNotExists(node);
    if (!created) return [];
    const data = ensureData(node);
    const previous = data[key] as T[] | undefined;
    (data as Record<string, unknown>)[key] = created;
    emitAssign(node, previous, created);
    return created;
  };

  const safeGet = <N extends DataBagNode>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[] => {
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
    const data = ensureData(node);
    const previous = data[key] as T[] | undefined;
    (data as Record<string, unknown>)[key] = created;
    emitAssign(node, previous, created);
    return created;
  };

  const is = <N extends DataBagNode>(
    node: N,
  ): node is N & { data: { [K in Key]: T[] } } => {
    const data = (node as DataBagNode).data;
    return !!data && key in data && Array.isArray(data[key]);
  };

  const collect = <Root>(root: Root): readonly T[] => {
    if (!defaultVisitFn) return [];
    const visit = defaultVisitFn as VisitFn<Root>;
    const buckets = collectData<T[], Key, Root>(root, key, visit);
    const out: T[] = [];
    for (const bucket of buckets) {
      if (Array.isArray(bucket)) out.push(...bucket);
    }
    return out;
  };

  const collectNodes = <Root, N extends DataBagNode = DataBagNode>(
    root: Root,
  ): readonly N[] => {
    const out: N[] = [];
    if (!defaultVisitFn) return out;
    const visit = defaultVisitFn as VisitFn<Root>;
    visit(root, (node) => {
      if (!is(node)) return;
      const arr = (node.data as Record<Key, unknown>)[key];
      if (Array.isArray(arr) && arr.length > 0) {
        out.push(node as unknown as N);
      }
    });
    return out;
  };

  const forEach = <Root>(
    root: Root,
    fn: (item: T, owner: DataBagNode) => void,
  ): void => {
    if (!defaultVisitFn) return;
    const visit = defaultVisitFn as VisitFn<Root>;
    forEachData<T[], Key, Root>(
      root,
      key,
      visit,
      (bucket, owner) => {
        if (!Array.isArray(bucket)) return;
        for (const item of bucket) {
          fn(item, owner);
        }
      },
    );
  };

  const hasAny = <Root>(root: Root): boolean => {
    if (!defaultVisitFn) return false;
    const visit = defaultVisitFn as VisitFn<Root>;
    let found = false;
    visit(root, (node) => {
      if (found) return;
      if (!is(node)) return;
      const arr = (node.data as Record<Key, unknown>)[key];
      if (Array.isArray(arr) && arr.length > 0) found = true;
    });
    return found;
  };

  factory = {
    key,
    events,
    add,
    get,
    safeGet,
    is,
    collect,
    collectNodes,
    forEach,
    hasAny,
    init<N extends DataBagNode>(
      node: N,
      opts?: { onFirstAccessAuto?: boolean },
    ) {
      runInit(node, !!opts?.onFirstAccessAuto);
    },
  };

  return factory;
}

/* -------------------------------------------------------------------------- */
/* Flexible text helper                                                       */
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
 *       visitFn: (root, visitor) => { ... },
 *     });
 *
 *   // Or if you don't care about a specific Node subtype:
 *   const fooDef = defineNodeData("foo" as const)<Foo>();
 */
export function defineNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: DataFactoryOptions<Key, T>,
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
 *       { merge: true, visitFn: (root, visitor) => { ... } },
 *     );
 */
export function defineSafeNodeData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    schema: z.ZodType<T>,
    options?: SafeDataFactoryOptions<Key, T>,
  ): NodeDataDef<Key, T, N> => ({
    key,
    factory: safeNodeDataFactory<Key, T>(key, schema, options),
  });
}

/* -------------------------------------------------------------------------- */
/* Type extractors for scalar/object data                                     */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Data definition helpers (array-valued data)                                */
/* -------------------------------------------------------------------------- */

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
 *     defineNodeArrayData("tags" as const)<string, Paragraph>({
 *       merge: true,
 *       visitFn: (root, visitor) => { ... },
 *     });
 */
export function defineNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    options?: ArrayDataFactoryOptions<Key, T>,
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
 *       { merge: true, visitFn: (root, visitor) => { ... } },
 *     );
 */
export function defineSafeNodeArrayData<Key extends string>(key: Key) {
  return <
    T,
    N extends DataBagNode = DataBagNode,
  >(
    itemSchema: z.ZodType<T>,
    options?: SafeArrayDataFactoryOptions<Key, T>,
  ): NodeArrayDataDef<Key, T, N> => ({
    key,
    factory: safeNodeArrayDataFactory<Key, T>(key, itemSchema, options),
  });
}

/* -------------------------------------------------------------------------- */
/* Type extractors for array-valued data                                      */
/* -------------------------------------------------------------------------- */

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
