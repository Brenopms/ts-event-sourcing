# ADR 0002: `fromVersion` Parameter on `EventStore.load`

## Status

Accepted

## Context

The `@ts-event-sourcing/snapshots` extension accelerates aggregate rebuilds by storing snapshot state at a given version and folding only post-snapshot events. However, the snapshot loader currently loads **all events** from the event store and slices them client-side:

```ts
const events = snapshot
  ? stream.events.slice(snapshot.version)
  : stream.events;
```

This wastes bandwidth and memory: if a snapshot exists at version 10,000 out of 10,050 events, the store returns all 10,050 events when only the last 50 are needed.

The `EventStore.load` method already supports `toVersion` (an inclusive upper bound) for partial rebuilds. Adding a symmetric `fromVersion` (exclusive lower bound) would allow the store to skip events before the snapshot version at the database level.

Two options were considered:

1. **Add `fromVersion` to `EventStore.load`** — a new optional parameter, symmetric with `toVersion`. The snapshot loader passes the snapshot version directly. Store implementations filter server-side. Minimal change to core.

2. **Keep client-side slicing** — the snapshot loader continues to slice in memory. The event store interface stays unchanged. Waste is bounded by snapshot frequency, but this leaks an optimization concern into the caller.

## Decision

**We chose option 1: add an optional `fromVersion?: number` parameter to `EventStore.load`.**

## Rationale

- **Symmetric with `toVersion`.** The store already supports an upper bound. Adding a lower bound is the natural complement — together they form a range query over event versions.
- **Eliminates waste at the source.** A production Postgres adapter can push the version filter into a `WHERE version > $1` clause. The caller (snapshot loader) drops the `slice()` call entirely.
- **Exclusive semantics match the snapshot use case.** A snapshot at version N means events 1..N are already accounted for. Passing `fromVersion: N` (exclusive) returns events N+1 onwards without the caller adding 1.
- **Backward compatible.** `fromVersion` is optional. Omitted = no lower bound = load from the beginning. All existing callers and store implementations are unchanged.
- **Consistent error handling.** Negative values and `fromVersion > toVersion` are rejected with a new `InvalidVersionRange` variant of `CoreError`, keeping value validation inside the contract.

## Consequences

- `EventStore.load` gains one optional parameter (`fromVersion`). The interface grows slightly.
- `CoreError` gains one new variant: `InvalidVersionRange`. Stores must validate parameter combinations.
- `lastVersion` in `LoadedStream` is now **always the stream's actual last version**, regardless of `fromVersion`/`toVersion` filtering. Previously, `toVersion` alone caused `lastVersion` to reflect the filtered set — this behavior was corrected as part of this change. The invariant becomes: `lastVersion` is a stream property, not a query-result property.
- The `InMemoryEventStore` reference implementation is updated to validate and filter against both bounds.
- The snapshot extension's `loadAggregateWithSnapshot` passes `fromVersion: snapshot.version` (or `0` when no snapshot exists) and drops the `slice()` call.
- No changes to `loadAggregate`, `rebuildAggregate`, `executeCommand`, or any other core function. They continue to call `store.load` without `fromVersion`.
