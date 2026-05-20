# ADR 0001: Optional `loader` Parameter on `executeCommand`

## Status

Accepted

## Context

The `@ts-event-sourcing/snapshots` extension needs to intercept the aggregate loading step inside `executeCommand` to use a snapshot-accelerated path (load snapshot → load post-snapshot events → incremental fold) instead of the default full replay.

Two options were considered:

1. **Add an optional `loader` parameter to core's `executeCommand`** — when present, the loader replaces steps 1–2 (store.load + rebuildAggregate). The post-append rebuild switches to an incremental fold. Non-breaking, additive change.

2. **Create a separate `executeCommandWithSnapshot` in the snapshot package** — duplicates the orchestration logic from core (load → handler → append → rebuild) but swaps in the snapshot-aware loading. Core stays completely untouched.

## Decision

**We chose option 1: add an optional `loader?: AggregateLoader<State, Event, LoaderError>` parameter to `executeCommand`.**

## Rationale

- **Single source of truth for command execution.** The canonical command flow (load → handler → append → rebuild) should not be duplicated across packages. Duplicating it risks divergence in behavior, error handling, and post-append rebuild semantics.
- **Minimal core change.** The `loader` parameter is optional and defaults to the existing behavior. No existing call sites break. No new error types. No behavioral change when omitted.
- **Clean extension point.** The `AggregateLoader` type already existed in the codebase as a declared concept. This formalizes it. Future extensions (caching, multi-stream aggregates) can use the same injection point.
- **Type-safe error propagation.** The `LoaderError` generic (defaulting to `never`) allows the error union to expand when a loader with custom errors is passed, while leaving the union unchanged for existing callers.

## Consequences

- `executeCommand` gains one generic parameter (`LoaderError`) and one optional parameter (`loader`). The function signature grows slightly.
- When a `loader` is present, step 5 (post-append rebuild) uses `fold(loadedState, reduce, newEvents)` instead of `rebuildAggregate(aggregate, loadedStream)`. Both produce the same result; the former avoids redundant replay.
- The `AggregateLoader` type gains a `LoaderError` generic parameter (default `never`), formalizing it as a first-class core type.
- Snapshot-adjacent errors (e.g., `SnapshotError`) propagate through the `LoaderError` channel, keeping core's own error types (`CoreError`) clean of snapshot concerns.
