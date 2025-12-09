# Courier Data Movement Library

Courier is Spry’s family of modules for moving data between systems in a
consistent, typed, and testable way.

It has three main goals:

1. Treat “data movement” (ETL/ELT, CDC, streaming, batch, etc.) as a first-class
   concept in Spry, not just ad-hoc scripts.
2. Provide a small, composable TypeScript API that can be used directly in Deno,
   but is generic enough to be wrapped by Spry markdown playbooks and notebooks.
3. Make Singer a “first-class citizen” of the Spry world, while still being a
   profile within a more general Data Movement Protocol (DataMP).

In other words: Courier is the infrastructure layer; Spry playbooks, pipelines,
and markdown notebooks are the orchestration and UX layers on top.

## DataMP and profiles

Courier starts by defining a protocol model, called the Data Movement Protocol
(DataMP or “Data Move”):

- A protocol id (`DataMoveProtocolId`) identifies which profile is in use, e.g.:

  - `"singer"` for Singer-style JSON messages.
  - `"data-move-protocol"` for Spry’s own control/diagnostics envelopes.
  - Other lowercase strings for additional profiles (CDC, logs, metrics, etc.).

- A “profile” is a concrete shape and behavior for messages on the wire. Singer
  is one such profile.

This lets Courier unify:

- Singer-style taps/targets that already speak the Singer JSON protocol.
- Spry-native taps/targets that speak typed DataMP messages and may be adapted
  into Singer or other profiles.
- Future profiles (e.g., bespoke CDC streams or observability feeds) without
  redesigning the system.

## What `protocol.ts` defines

`protocol.ts` is the foundational module for Courier. It provides:

3.1 Wire-level Singer schemas

Type-safe Zod schemas for canonical Singer messages:

- `SingerMessageType` – discriminator: "SCHEMA", "RECORD", "STATE",
  "ACTIVATE_VERSION".
- `singerSchemaWireSchema` – Singer SCHEMA messages (stream, JSON Schema, key
  and bookmark properties).
- `singerRecordWireSchema` – Singer RECORD messages (stream, record object,
  extracted time, version).
- `singerStateWireSchema` – Singer STATE messages (opaque state JSON).
- `singerActivateVersionWireSchema` – Singer ACTIVATE_VERSION messages (stream +
  version).
- `singerWireMessageSchema` – discriminated union of all Singer wire messages.

These provide a typed, validated surface for interacting with existing Singer
taps and targets.

3.2 Spry superset messages (Data Move Superset)

A small Spry-specific envelope layer for control and diagnostics:

- `dataMoveNatureSchema` – nature of the message: "TRACE", "ERROR", "BARRIER",
  "METRICS".
- Base envelope with:

  - `protocol: "data-move-protocol"`
  - `nature`
  - optional `stream`, `payload`, `ts`.

Concrete superset message types:

- `dmTraceMessageSchema` – TRACE diagnostics with message, optional level
  (debug/info/warn).
- `dmErrorMessageSchema` – ERROR envelope with human-readable `error` and
  optional `details`.
- `dmBarrierMessageSchema` – BARRIER envelope for checkpoints, with `barrierId`.
- `dmMetricsMessageSchema` – METRICS envelope with a string→number map.

All of these are combined in `dataMoveMessageSchema`, the discriminated union on
`nature`.

This gives Courier a standard way to carry logs, errors, metrics, and pipeline
barriers alongside data records.

3.3 Unified wire message union

`dataMoveWireMessageSchema` is the top-level of the wire side:

- Union of `singerWireMessageSchema` + `dataMoveMessageSchema`.

This is the “everything that can appear on the wire” union for initial profiles.
It allows a single stream or log to carry both Singer data and Spry control
messages.

3.4 Typed Zod layer for Data Move streams

On top of the wire format, Courier defines a typed layer for actual data:

- `StreamSchemaMap` – map from stream name to Zod object schema.
- `InferStreamRecord` – infers the TypeScript type of records for a given stream
  key.
- `DataMoveStreamDef` – definition of a stream:

  - `name`
  - `schema` (the Zod schema)
  - optional `keyProperties`
  - optional `bookmarkProperties`

This is the bridge between:

- Strongly typed data models (per stream, using Zod).
- Profile-specific representations on the wire (Singer, Spry superset, etc.).

3.5 Typed Data Move messages

Typed typed-level abstractions:

- `dataMoveTypedSchemaMessageSchema(schemas)` – typed SCHEMA messages which wrap
  a `DataMoveStreamDef`.
- `dataMoveTypedRecordMessageSchema(streamName, streamSchema)` – typed RECORD
  messages for a given stream.
- `dataMoveTypedStateMessageSchema<TState>()` – typed STATE messages for
  arbitrary state shapes.

A generic union function:

- `dataMoveTypedMessageSchema(schemas, TState?)` – returns a union of:

  - typed SCHEMA messages,
  - typed STATE messages,
  - a generic RECORD message,
  - and Data Move superset messages (TRACE/ERROR/BARRIER/METRICS).

These define how the Data Move Engine sees messages internally: as typed,
Zod-validated objects rather than raw JSON.

3.6 Transforms between typed and Singer wire

Zod transforms are used to adapt typed messages into Singer profile messages:

- `dataMoveTypedRecordToSingerRecordWireSchema(streamName, streamSchema)`

  - Typed RECORD → Singer RECORD wire shape.
- `dataMoveTypedStateToSingerStateWireSchema<TState>()`

  - Typed STATE → Singer STATE wire shape (opaque JSON).
- `dataMoveSingerSchemaWireFromMetaSchema`

  - Takes metadata (stream name, JSON Schema, key/bookmark properties) and
    generates a Singer SCHEMA wire message.

These are the primary adaptation points for using typed pipelines with Singer
tools.

3.7 Data Move Engine (taps, targets, transforms, pipeline)

Defines the core runtime plumbing:

- `DataMoveTapContext<TState>` – context for taps, including initial state.
- `DataMoveTap<TSchemas, TState>` – a source of messages:

  - `id`
  - `streams` – map of stream definitions
  - `read(ctx)` – async iterator of `DataMoveTypedMessage`.
- `DataMoveTarget<TSchemas, TState>` – a sink:

  - `id`
  - optional `init()`
  - `handleMessage(msg)`
  - optional `finalize()`
- `DataMoveMessageTransform<TSchemas, TState>` – mid-pipeline transform/filter:

  - `name`
  - `apply(msg)` returns one, many, or zero messages (sync or async).
- `DataMovePipelineOptions<TSchemas, TState>` – describes a pipeline:

  - `tap`
  - `target`
  - optional `transforms[]`
  - optional `initialState`, `onState(state)` callback
  - optional `logger`

The pipeline runner:

- `dataMovementPipeline(opts)`:

  - Calls `target.init()`.
  - Iterates the tap, runs each message through transforms.
  - Delivers final messages to the target.
  - Tracks and surfaces STATE messages via `onState`.
  - Logs and rethrows target errors.
  - Calls `target.finalize()` at the end.

This is the “engine block” of Courier: taps + transforms + target wired together
in a standard way.

3.8 Single-stream convenience helpers

For simple or early use cases, Courier provides helpers for single-stream
scenarios:

- `dataMoveSingleStreamMap(name, schema)` – build a one-stream
  `StreamSchemaMap`.
- `dataMoveSingleStreamDef(name, schema, opts?)` – build a single
  `DataMoveStreamDef`.
- `dataMoveSingleStreamRecordMessageSchema(streamName, schema)` – typed RECORD
  schema for single-stream pipelines.
- `dataMoveSingleStreamRecordToSingerWireSchema(streamName, schema)` – direct
  transform from typed single-stream RECORD to Singer RECORD wire message.

These helpers make it easy to use Courier in small utilities or prototypes
without committing to multi-stream complexity.

## What mod_test.ts does

`mod_test.ts` for Courier is designed as both a correctness suite and a living
spec for how to use `protocol.ts`.

At a high level it:

1. Validates the Singer schemas

   - Uses canonical-looking SCHEMA, RECORD, STATE, and ACTIVATE_VERSION messages
     (inspired by Singer docs).
   - Ensures `singer*WireSchema` and `singerWireMessageSchema` accept and
     preserve these messages.
   - Confirms `dataMoveWireMessageSchema` can accept a Singer RECORD as part of
     its union.

2. Exercises typed ↔ Singer transforms

   - Builds a simple `users` stream schema with Zod.
   - Verifies:

     - Typed RECORD messages round-trip through
       `dataMoveTypedRecordMessageSchema`.
     - Typed → Singer transform for RECORD and STATE behave as expected.
     - The metadata-driven SCHEMA builder
       (`dataMoveSingerSchemaWireFromMetaSchema`) produces a valid Singer
       SCHEMA.

3. Demonstrates the typed union

   - Uses `dataMoveTypedMessageSchema` to:

     - Parse a typed SCHEMA message.
     - Parse a typed STATE message.
     - Parse a typed RECORD message.
     - Parse a TRACE message from the Spry superset.
   - Documented via tests as examples of the union’s behavior and how to safely
     cast/narrow variants.

4. Covers single-stream helpers

   - Shows how to:

     - Create a single-stream schema map.
     - Create a single-stream `DataMoveStreamDef`.
     - Build a single-stream RECORD schema.
     - Transform a single-stream typed RECORD into a Singer RECORD wire message.

5. Exercises the Data Move Engine end-to-end

   - Defines a synthetic `users` tap emitting:

     - A typed SCHEMA message.
     - A sequence of typed RECORD messages.
     - A typed STATE message that increments a cursor/offset.
     - A BARRIER message using the superset schema.
   - Defines an in-memory target that:

     - Tracks `init()` and `finalize()` calls.
     - Collects every message it receives.
   - Runs pipelines in three modes:

     - Simple tap → target (no transforms) with state handling.
     - With transforms that:

       - Filter out certain records.
       - Duplicate others.
     - With a “failing” target to confirm error logging and propagation.

6. Validates the superset diagnostics

   - Creates examples of TRACE, ERROR, BARRIER, and METRICS messages.
   - Ensures `dataMoveMessageSchema` correctly discriminates and preserves their
     fields.

Together, these tests serve as:

- A spec for how Courier is supposed to behave today.
- A set of concrete, copy-pastable patterns for future modules (other profiles,
  more complex taps/targets, etc.).
- A safety net for refactors in `protocol.ts` and future Courier modules.

## Future evolution of Courier

Courier is meant to grow into a full family of modules under the `courier`
namespace:

- New profiles

  - Additional `DataMoveProtocolId` values for non-Singer integrations (CDC, log
    shipping, observability data, etc.).
  - Profile-specific adapters similar to the current Singer transforms.

- Transports

  - Adapters for stdin/stdout, HTTP, S3/Blob storage, message queues, etc.
  - Reusable components that can “speak” DataMP on top of these transports.

- Higher-level orchestration hooks

  - Utilities for wiring Courier pipelines from Spry markdown playbooks and
    notebooks.
  - Prebuilt taps and targets for common data sources (e.g., CSV, SQLite, HTTP
    APIs, etc.).

The design principle: Courier stays focused on typed data movement and
protocol-level concerns; Spry layers on orchestration, UX, and markdown-native
workflows.

## Summary

- `courier` is the Spry library for typed, protocol-aware data movement.

- `protocol.ts` defines the DataMP core:
  - Singer wire schemas,
  - Spry superset diagnostics,
  - typed Zod schemas,
  - and the Data Move Engine.

- `mod_test.ts` is both verification and documentation:
  - It demonstrates typical usage of the schemas, transforms, and pipeline
    engine.
  - It validates behavior end-to-end with synthetic Singer-style taps and
    targets.

This gives Spry a solid, test-driven foundation to build richer orchestration
and “data courier” behavior on top of DataMP.
