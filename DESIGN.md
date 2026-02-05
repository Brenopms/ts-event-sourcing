# Typed Event Sourcing Core for TypeScript

**Design Document (v1)**

---

## 1. Overview

This library is a **minimal, opinionated, strongly typed event-sourcing core** for TypeScript.

It provides:

* A **functional kernel** for event-sourced aggregates
* **Compile-time guarantees** for exhaustiveness and correctness
* A **Result-based error model**
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

   * Exhaustive handling of events and commands
   * Invalid states should not compile
   * Compiler as the primary correctness tool

4. **Explicit failure model**

   * No exceptions crossing the library boundary
   * All failures are typed
   * Clear failure points

5. **Infrastructure agnostic**

   * No Kafka, no HTTP, no DB assumptions
   * Storage, messaging, snapshots live outside core

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

These concerns are intentionally left to **adapters and extensions**.

---

## 4. Core Philosophy

### 4.1 Functional Core, Imperative Shell

* Domain logic is **pure**
* Side effects are isolated in adapters
* Core code is deterministic and testable

### 4.2 If It Compiles, It’s Correct

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

Commands represent intent, not facts.

```ts
export type AnyCommand = {
  type: string
}
```

Reasoning:

* Commands are optional but encouraged
* Separating intent from facts improves modeling
* Same exhaustiveness guarantees as events

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
* Removes “first event” edge cases

---

## 6. Result-Based Error Model

### 6.1 Why Result<T, E>

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

Exceptions may exist *inside adapters*, but are caught and converted.

---

### 6.2 Core Error Algebra

The core defines **only technical errors**, never domain errors.

```ts
export type CoreError =
  | { type: "StreamNotFound" }
  | { type: "ConcurrencyConflict"; expected: number; actual: number }
  | { type: "IdempotencyViolation" }
  | { type: "StoreError"; cause: unknown }
  | { type: "ReducerError"; cause: unknown }
  | { type: "HandlerError"; cause: unknown }
```

Reasoning:

* Keeps domain concerns out of infrastructure
* Makes failure modes explicit
* Allows adapters to enrich errors if needed

---

## 7. Event Matching (Exhaustiveness by Design)

### 7.1 Motivation

Traditional `switch(event.type)`:

* Allows missing cases
* Requires default branches
* Degrades as unions grow

We instead use **total matchers**.

---

### 7.2 Matcher Type

```ts
export type EventMatcher<
  E extends AnyEvent,
  R
> = {
  [K in E["type"]]: (event: Extract<E, { type: K }>) => R
}
```

Guarantees:

* Every event is handled
* Payload types are exact
* Refactors are compiler-guided

---

### 7.3 matchEvent

```ts
export function matchEvent<
  E extends AnyEvent,
  R
>(
  event: E,
  matcher: EventMatcher<E, R>
): R
```

Reasoning:

* Zero runtime overhead
* Centralized `any` usage
* Enforced exhaustiveness

This function is **part of core**, not an optional helper.

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

---

### 8.2 Command Handler

```ts
export type CommandHandler<
  State,
  Command extends AnyCommand,
  Event extends AnyEvent
> = (
  state: State,
  command: Command
) => readonly Event[]
```

Reasoning:

* Emits events, not state
* Enforces separation of decision and evolution
* Domain errors are modeled by the user (events, empty array, or external Result)

---

### 8.3 Aggregate Definition

```ts
export type AggregateDefinition<
  State,
  Event extends AnyEvent,
  Command extends AnyCommand
> = {
  initialState: State
  reduce: Reducer<State, Event>
  handle: CommandHandler<State, Command, Event>
}
```

Opinionated constraints:

* One reducer
* One handler
* No lifecycle hooks
* No side effects

---

## 9. Event Store Contract

### 9.1 Persisted Events

```ts
export type PersistedEvent<E extends AnyEvent> = E & {
  version: number
}
```

Versioning:

* Required
* Assigned by the store
* Used for optimistic locking

---

### 9.2 Event Store Interface

```ts
export interface EventStore<E extends AnyEvent> {
  load(
    streamId: string
  ): Promise<Result<{
    events: readonly PersistedEvent<E>[]
    version: number
  }, CoreError>>

  append(params: {
    streamId: string
    expectedVersion: number
    events: readonly E[]
    idempotencyKey: string
  }): Promise<Result<{
    events: readonly PersistedEvent<E>[]
    version: number
  }, CoreError>>
}
```

Guarantees:

* Append-only
* Optimistic concurrency via version
* Idempotency enforced by store

---

## 10. Idempotency Model

* **Mandatory**
* Required at command execution
* Enforced by the store
* Core does not cache or dedupe

Reasoning:

* Keeps core stateless
* Enables retries
* Aligns with distributed systems realities

---

## 11. Aggregate Execution Engine

### 11.1 Public API

```ts
export async function executeCommand<
  State,
  Event extends AnyEvent,
  Command extends AnyCommand
>(params: {
  store: EventStore<Event>
  aggregate: AggregateDefinition<State, Event, Command>
  streamId: string
  command: Command
  idempotencyKey: string
}): Promise<Result<{
  state: State
  events: readonly PersistedEvent<Event>[]
  version: number
}, CoreError>>
```

---

### 11.2 Execution Steps

1. Load events + version
2. Reduce events → current state
3. Handle command → new events
4. Append with expected version + idempotency key
5. Reduce new events → new state
6. Return state, events, version

All steps are wrapped in `Result`.

---

## 12. Projections

### 12.1 Pull-based Only

Projections are:

* Deterministic
* Replayable
* Stateless with respect to the core

Push-based subscriptions are explicitly excluded.

---

## 13. Snapshots

* Out of core
* Implemented as an extension
* Store adapters may combine snapshot + events internally

Reasoning:

* Keeps the kernel minimal
* Avoids lifecycle complexity
* Preserves determinism

---

## 14. Extension Model

The core is designed to support:

* In-memory store
* PostgreSQL store
* Kafka-backed store
* Snapshot adapters
* Projection runners
* Testing utilities

All extensions depend on the core — never the reverse.

---

## 15. Public API (v1)

The **entire public surface**:

* `Result`, `Ok`, `Err`
* `AnyEvent`, `AnyCommand`
* `matchEvent`
* `AggregateDefinition`
* `EventStore`
* `executeCommand`

Nothing else.

---

## 16. Summary

This library is:

* Small
* Explicit
* Deterministic
* Strongly typed
* Designed for senior engineers
* Designed to scale in complexity **outside** the core

It intentionally chooses **clarity over convenience** and **correctness over abstraction**.
