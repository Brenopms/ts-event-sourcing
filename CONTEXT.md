# Typed Event Sourcing Core — Glossary

## Event

An immutable, append-only fact representing something that happened. Events are the **only source of truth** in the system. They form discriminated unions and carry a `type` discriminant for exhaustive matching.

## Event Store (`EventStore<E>`)

The persistence contract for events. Defines two operations:

- **`load`** — retrieves events from a stream. Accepts optional `fromVersion` (exclusive lower bound) and `toVersion` (inclusive upper bound) to request a range of events. Returns a `StreamState` indicating whether the stream exists and providing events.
- **`append`** — atomically appends events to a stream with optimistic concurrency control and idempotency enforcement.

## Event Stream

An ordered, append-only sequence of events identified by a `streamId`. Each aggregate maps to exactly one stream. Events within a stream are versioned monotonically starting from 1.

## Stream State (`StreamState<E>`)

A discriminated union representing whether a stream exists:

- **`EmptyStream`** — the stream has never been created. `lastVersion` is 0.
- **`LoadedStream`** — the stream exists and contains events. `lastVersion` reflects the stream's actual last event version, regardless of any `fromVersion`/`toVersion` filtering applied during load.

## Version

A monotonically increasing integer assigned to each event within a stream by the event store. Versions start at 1. `lastVersion` always represents the stream's actual event count, never a filtered subset.

## `fromVersion`

An optional, **exclusive** lower bound on `EventStore.load`. When set to N, only events with version > N are returned. Used by snapshot-aware loaders to skip events already folded into a snapshot. A value of 0 means "from the beginning" (no-op). Negative values are invalid.

## `toVersion`

An optional, **inclusive** upper bound on `EventStore.load`. When set to N, events with version ≤ N are returned. Useful for partial rebuilds and time-travel queries. Negative values are invalid.

## `InvalidVersionRange`

A `CoreError` variant raised when `fromVersion > toVersion` or when either parameter is negative. Carries both values to aid debugging.

## Aggregate

A domain entity whose state is derived by folding a stream of events through a pure `reducer`. Defined by an `AggregateDefinition` (initial state + reducer). Aggregates are rebuilt deterministically from events — they are never stored directly.

## Aggregate Loader (`AggregateLoader`)

A pluggable loading strategy that replaces the default `store.load` + `rebuildAggregate` sequence inside `executeCommand`. Receives the store, aggregate definition, and stream ID. Enables snapshot-accelerated loading, caching, and other custom strategies without modifying core.

## Command Handler

A pure function `(state, command) => Result<events, domainError>` that decides which events to emit based on current aggregate state and an incoming command. Returns typed domain errors (not thrown exceptions). May return an empty event array for a deliberate no-op.

## Optimistic Concurrency

Enforced via `expectedVersion` on append. The caller passes the `lastVersion` it observed; the store rejects the append if the stream's version no longer matches. This prevents lost writes without locks.

## Idempotency

Guaranteed via `idempotencyKey` on append. The store must never re-append events for a key it has already processed. Enables safe retries in distributed systems.

## Projection

A read model derived by folding events through a `fold` function. Unlike aggregates, projections may ignore events and are intentionally lossy — they produce views that cannot round-trip back to the full event history.
