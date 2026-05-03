# Typed Event Sourcing Core for TypeScript

**Design Document (v2)**

---

## 1. Overview

This library is a **minimal, opinionated, strongly typed event-sourcing core** for TypeScript.

It provides:

* A **functional kernel** for event-sourced aggregates
* **Compile-time guarantees** for exhaustiveness and correctness
* A **Result-based error model** with composable combinators
* **Zero infrastructure coupling**

The goal is not to be a framework, but a **foundational primitive** upon which higher-level systems (CQRS, projections, messaging, workflows) can be built.

---

## 2. Design Goals

### 2.1 Primary Goals

1. **Minimal core**

   * Small surface area
   * Easy to reason about
   * Easy to extend externally

2. **Opinionated**

   * One aggregate = one stream
   * Append-only
   * Pure functions only
   * No hidden magic

3. **Strong typing**

   * Exhaustive handling of events
   * Invalid states should not compile
   * Compiler as the primary correctness tool

4. **Explicit failure model**

   * No exceptions crossing the library boundary
   * All failures are typed
   * Clear, distinct failure points

5. **Infrastructure agnostic**

   * No Kafka, no HTTP, no DB assumptions
   * Storage, messaging, and snapshots live outside the core

6. **Deterministic**

   * Replaying events always yields the same state
   * Projections are replayable by design

---

## 3. Non-Goals

The following are **explicitly out of scope**:

* Push-based subscriptions
* CQRS frameworks
* Sagas / process managers
* Multi-stream transactions
* Messaging guarantees (exactly-once, ordering across streams)
* Dependency injection
* Decorators or reflection
* Runtime schema validation
* Snapshotting (extension point, not core concern)

These concerns are intentionally left to **adapters and extensions**.

---

## 4. Core Philosophy

### 4.1 Functional Core, Imperative Shell

* Domain logic is **pure**
* Side effects are isolated in adapters
* Core code is deterministic and testable without infrastructure

### 4.2 If It Compiles, It's Correct

The library is designed so that:

* Missing event handlers fail at compile time
* Invalid event emissions fail at compile time
* Reducers are total functions
* Command handling cannot produce unknown events

---

## 5. Fundamental Concepts

### 5.1 Events

Events are:

* Immutable
* Append-only
* Discriminated unions
* The *only* source of truth

```ts
export type AnyEvent = {
  type: string
}
```

Reasoning:

* Discriminated unions give maximal type safety
* No classes → better serialization, easier testing
* No base event class → no inheritance coupling

---

### 5.2 Commands

Commands represent intent, not facts. They are not discriminated unions at the
library level — command types are user-defined and passed directly to handlers.

```

Reasoning:

* Commands are optional but encouraged
* Separating intent from facts improves modeling
* The `AnyCommand` constraint is a structural minimum, not a base class

---

### 5.3 State

State is:

* Explicit
* Fully derived from events
* Never `undefined`

```ts
initialState: State
```

Reasoning:

* Avoids partial or invalid runtime states
* Simplifies reducers
* Removes "first event" edge cases

---

## 6. Result-Based Error Model

### 6.1 Why Result\<T, E\>

The library **never throws across boundaries**.

Instead:

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E }
```

Reasoning:

* Explicit control flow
* Composable
* Test-friendly
* No hidden runtime behavior

Exceptions may exist *inside adapters*, but are caught and converted to `Result`.

---

### 6.2 Result Constructors

```ts
export const Ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })
```

---

### 6.3 Result Combinators

To avoid repetitive `if (!result.ok)` guards, the library ships three composable
combinators. They follow the same short-circuit semantics: an `Err` at any step
propagates automatically without calling subsequent functions.

```ts
// Transform the success value without introducing a new failure mode
export function mapOk<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E>

// Chain an async step that itself returns a Result
export async function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Promise<Result<U, E>>
): Promise<Result<U, E>>

// Chain a synchronous step that itself returns a Result
export function andThenSync<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E>

// Extract the success value or throw — use only at app boundaries or in tests
export function unwrap<T, E>(result: Result<T, E>): T
```

Reasoning:

* Eliminates defensive boilerplate in calling code
* Makes the happy path linear and readable
* `unwrap` is intentionally unsafe — it signals a deliberate boundary decision,
  not routine error handling

---

### 6.4 Core Error Algebra

The core defines **only technical errors**, never domain errors.
Domain-specific errors are expressed via the `CommandHandler` generic parameter.

```ts
export type CoreError =
  | { type: "StreamNotFound" }
  | { type: "AggregateNotFound" }
  | { type: "AggregateAlreadyExists" }
  | { type: "StoreError"; cause: unknown }
  | { type: "ConcurrencyConflict"; expected: number; actual: number }
  | { type: "IdempotencyViolation" }
```

Reasoning:

* Keeps domain concerns out of infrastructure
* Makes failure modes explicit and exhaustively matchable
* Allows adapters to enrich errors if needed

---

## 7. Event Matching (Exhaustiveness by Design)

### 7.1 Motivation

Traditional `switch(event.type)`:

* Allows missing cases
* Requires default branches
* Degrades silently as event unions grow

We instead use **total matchers**.

---

### 7.2 Matcher Types

```ts
// Exhaustive — every event type in the union must be handled
export type EventMatcher<E extends AnyEvent, R> = {
  [K in E["type"]]: (event: Extract<E, { type: K }>) => R
}

// Partial — only a subset of event types need to be handled
export type PartialEventMatcher<E extends AnyEvent, R> = {
  [K in E["type"]]?: (event: Extract<E, { type: K }>) => R
}
```

Guarantees of the exhaustive matcher:

* Every event variant is handled
* Payload types are exactly narrowed
* Adding a new event type to the union causes a compile error at every unhandled matcher

---

### 7.3 matchEvent

```ts
export function matchEvent<E extends AnyEvent, T extends E["type"], R>(
  event: Extract<E, { type: T }>,
  matcher: EventMatcher<E, R>
): R
```

Reasoning:

* Zero runtime overhead
* Centralized `any` usage
* Enforced exhaustiveness at compile time

This function is **part of core** and is the recommended way to implement reducers.

---

### 7.4 matchEventPartial

```ts
export function matchEventPartial<E extends AnyEvent, T extends E["type"], R>(
  event: Extract<E, { type: T }>,
  matcher: Partial<EventMatcher<E, R>>
): Partial<R> | undefined
```

Intended for use cases where only some events are relevant — process managers,
saga handlers, read-side projections that ignore certain event types. Returns
`undefined` when no handler is registered for the event.

---

## 8. Aggregate Model

### 8.1 Reducer

```ts
export type Reducer<State, Event extends AnyEvent> = (
  state: State,
  event: Event
) => State
```

Properties:

* Pure
* Total
* Deterministic

The reducer is the only mechanism for evolving aggregate state.

---

### 8.2 Aggregate Definition

Commands are **not** part of the aggregate definition. The aggregate is a pure
data-evolution contract: initial state and a reducer. Command handling is wired
separately (see §10).

```ts
export type AggregateDefinition<State, Event extends AnyEvent> = {
  initialState: State
  reduce: Reducer<State, Event>
}
```

Reasoning:

* Decouples state evolution from command decision-making
* Allows multiple command handlers per aggregate without coupling them
* Makes aggregates independently testable from command logic

---

### 8.3 Command Handler

Command handlers are **pure functions** that decide which events to emit.
Domain errors are expressed as typed `Err` values, not thrown exceptions.

```ts
export type CommandHandler<State, Command, Event extends AnyEvent, Error> = (params: {
  state: State
  command: Command
}) => Result<readonly Event[], Error>
```

Reasoning:

* Emits events, not state
* Domain errors are typed and in-band — no exceptions
* Returning an empty array represents a deliberate no-op
* The `Error` type parameter keeps domain and infrastructure errors separate

---

## 9. Event Store Contract

### 9.1 Stream State

The store distinguishes between a stream that has never existed and one that exists
but may have zero events at a given version. This distinction matters for aggregate
lifecycle (creation vs. load).

```ts
export type EmptyStream = {
  type: "empty"
  lastVersion: 0
  events: []
}

export type LoadedStream<E> = {
  type: "loaded"
  lastVersion: number
  events: E[]
}

export type StreamState<E> = EmptyStream | LoadedStream<E>
```

---

### 9.2 Persisted Events

```ts
export type PersistedEvent<E extends AnyEvent> = E & {
  version: number
}
```

Versioning:

* Required for optimistic concurrency
* Assigned by the store, not the caller
* Monotonically increasing within a stream

---

### 9.3 Event Store Interface

```ts
export interface EventStore<E extends AnyEvent> {
  load(params: {
    streamId: string
    toVersion?: number  // optional upper bound for partial rebuilds
  }): Promise<Result<StreamState<E>, CoreError>>

  append(params: {
    streamId: string
    expectedVersion: number
    events: readonly E[]
    idempotencyKey: string
  }): Promise<Result<{
    events: readonly PersistedEvent<E>[]
    lastVersion: number
  }, CoreError>>
}
```

Guarantees:

* Append-only
* Optimistic concurrency enforced via `expectedVersion`
* Idempotency enforced via `idempotencyKey`
* `load` with `toVersion` enables partial rebuilds and time-travel queries

---

## 10. Idempotency Model

* **Mandatory** on every append
* Required at command execution time
* Enforced by the store implementation
* Core does not cache or deduplicate

Reasoning:

* Keeps core stateless
* Enables safe retries in distributed systems
* Responsibility for generating keys lies with the caller

---

## 11. Aggregate Lifecycle

The library separates aggregate lifecycle into three explicit operations, each with
distinct semantics. This avoids implicit "upsert" behaviour where creation and
mutation share a code path.

### 11.1 createAggregate

Creates a new aggregate stream. Fails if the stream already exists.

```ts
export async function createAggregate<S, E extends AnyEvent>(params: {
  store: EventStore<E>
  streamId: string
  events: readonly E[]
  idempotencyKey: string
}): Promise<Result<{ lastVersion: number }, CoreError>>
```

Failure modes:

* `AggregateAlreadyExists` — stream already exists
* `StoreError` — store failed to load or append

---

### 11.2 loadAggregate

Loads an existing aggregate and rebuilds its current state. Fails if the stream
does not exist.

```ts
export async function loadAggregate<S, E extends AnyEvent>(params: {
  store: EventStore<E>
  streamId: string
  aggregate: AggregateDefinition<S, E>
}): Promise<Result<{ state: S; lastVersion: number }, CoreError>>
```

Failure modes:

* `AggregateNotFound` — stream is empty (never created)
* `StoreError` — store failed to load

---

### 11.3 rebuildAggregate

A low-level helper that folds a `LoadedStream` into aggregate state using the
aggregate's reducer. It is synchronous and never fails.

```ts
export function rebuildAggregate<S, E extends AnyEvent>(params: {
  aggregate: AggregateDefinition<S, E>
  stream: LoadedStream<E>
}): S
```

This function is primarily an internal building block used by `loadAggregate`
and `executeCommand`. It is exported to support advanced use cases (e.g. testing
reducers in isolation, snapshot extensions), but most callers should prefer
`loadAggregate`.

---

## 12. Command Execution Engine

### 12.1 executeCommand

Executes a command against an **existing** aggregate stream. This is the canonical
command execution entry point.

```ts
export async function executeCommand<State, Event extends AnyEvent, Command, Error>(params: {
  store: EventStore<Event>
  aggregate: AggregateDefinition<State, Event>
  streamId: string
  command: Command
  idempotencyKey: string
  handler: CommandHandler<State, Command, Event, Error>
}): Promise<Result<{
  state: State
  events: readonly Event[]
  lastVersion: number
}, Error | CoreError>>
```

Execution steps:

1. Load the event stream from the store
2. Rebuild current aggregate state by folding past events
3. Call the command handler with the current state and command
4. If the handler returns events, append them with optimistic concurrency control
5. Rebuild the post-append state from the authoritative event list
6. Return the new state, emitted events, and last version

All steps are wrapped in `Result`. No step executes if a prior step fails.

Failure modes:

* `StreamNotFound` — stream does not exist (use `createAggregate` first)
* `StoreError` — store failed to load or append
* Any domain error returned by the handler

---

### 12.2 defineCommand

A higher-level ergonomic wrapper that binds an aggregate definition and a command
handler together into a single executable unit. Removes the need to pass `aggregate`
and `handler` at every call site.

```ts
export function defineCommand<S, C, E extends AnyEvent, Err>(params: {
  aggregate: AggregateDefinition<S, E>
  handler: CommandHandler<S, C, E, Err | CoreError>
}): DefinedCommand<S, C, E, Err>
```

A `DefinedCommand` exposes a single `execute` method:

```ts
type DefinedCommand<S, C, E extends AnyEvent, Err> = {
  execute(input: {
    store: EventStore<E>
    streamId: string
    command: C
    idempotencyKey: string
  }): Promise<Result<{ state: S; events: readonly E[]; lastVersion: number }, Err | CoreError>>
}
```

Reasoning:

* Reduces call-site boilerplate
* Co-locates aggregate + handler definitions
* Preserves full type inference for state, command, events, and errors


---

## 13. Projections

### 13.1 Pull-Based Only

Projections are read models derived from an event stream. They are:

* Deterministic
* Replayable
* Stateless with respect to the core

Push-based subscriptions are explicitly out of scope.

---

### 13.2 Projection Definition

```ts
export type Projection<S, E extends AnyEvent> = {
  initialState: S
  fold: (state: S, event: E) => S
}
```

Unlike aggregates, projections use `fold` instead of `reduce` to signal that they
are intentionally lossy — they may ignore events, denormalise data, or produce
views that cannot round-trip back to the full event history.

---

### 13.3 project

```ts
export async function project<S, E extends AnyEvent>(params: {
  store: EventStore<E>
  streamId: string
  projection: Projection<S, E>
  options?: { toVersion?: number }
}): Promise<Result<{ state: S; lastVersion: number }, CoreError>>
```

The optional `toVersion` parameter enables partial rebuilds — useful for
time-travel queries, debugging, and snapshot-based extensions.

Failure modes:

* `StreamNotFound` — stream does not exist
* `StoreError` — store failed to load

---

## 14. In-Memory Store

A reference `EventStore<E>` implementation is included for local development and
testing. It is **not intended for production use**.

```ts
export class InMemoryEventStore<E extends AnyEvent> implements EventStore<E>
```

It provides:

* Optimistic locking via version comparison
* Idempotency enforcement via stored keys
* Deterministic event ordering
* Partial load via `toVersion`

It does **not** provide durability, cross-process safety, or high concurrency guarantees.

---

## 15. Snapshots

* Out of core
* Implemented as an extension
* Store adapters may combine snapshot + events internally

Reasoning:

* Keeps the kernel minimal
* Avoids lifecycle complexity
* Preserves determinism

---

## 16. Extension Model

The core is designed to support the following as external extensions:

* PostgreSQL / EventStoreDB / Kafka-backed store adapters
* Snapshot adapters
* Projection runners and materializers
* Testing utilities

All extensions depend on the core — never the reverse.

---

## 17. Public API (v2)

The full public surface of the library:

**Core primitives**

* `Result`, `Ok`, `Err`
* `mapOk`, `andThen`, `andThenSync`, `unwrap`
* `AnyEvent`, `AnyCommand`
* `CoreError`

**Event matching**

* `matchEvent`, `EventMatcher`
* `match`
* `matchEventPartial`

**Aggregate**

* `AggregateDefinition`, `Reducer`
* `createAggregate`
* `loadAggregate`
* `rebuildAggregate` *(low-level)*

**Command**

* `CommandHandler`
* `executeCommand`
* `defineCommand`

**Projections**

* `Projection`
* `project`

**Event store**

* `EventStore` *(interface)*
* `StreamState`, `EmptyStream`, `LoadedStream`
* `PersistedEvent`
* `InMemoryEventStore` *(reference implementation)*

---

## 18. Summary

This library is:

* Explicit
* Deterministic
* Strongly typed
* Designed for senior engineers
* Designed to scale in complexity **outside** the core

It intentionally chooses **clarity over convenience** and **correctness over abstraction**.
