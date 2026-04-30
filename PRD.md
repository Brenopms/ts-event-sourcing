# Product Requirements Document: Typed Event Sourcing Core for TypeScript

## 1. Executive Summary

The **Typed Event Sourcing Core** is a minimal, opinionated, strongly typed library for building event‑sourced aggregates in TypeScript. It provides a functional kernel – pure reducers, total event matchers, and a Result‑based error model – with **zero infrastructure coupling**. The core is not a framework; it is a foundational primitive upon which higher‑level systems (CQRS, projections, messaging, sagas, workflows) can be built.

The primary value proposition: **if it compiles, it’s correct**. Exhaustive event handling, explicit aggregate lifecycle, and deterministic replay guarantee correctness without runtime surprises.

## 2. Problem Statement

Building event‑sourced systems in TypeScript often leads to:

- **Weak type safety** – switch statements over `event.type` allow missing cases.
- **Hidden side effects** – command handlers that directly access databases or message queues.
- **Implicit aggregate creation** – confusing “upsert” behaviour that hides the first event.
- **Error handling via exceptions** – unclear failure paths and lost stack traces.
- **Infrastructure coupling** – event store, message bus, and snapshot logic tangled with domain code.

Developers need a **reliable, type‑safe foundation** that separates pure domain logic from infrastructure, enforces deterministic replay, and makes failure modes explicit – without imposing a heavy framework or runtime magic.

## 3. Target Users

- **Backend engineers** building event‑sourced systems (e‑commerce, finance, logistics) in TypeScript.
- **Library authors** creating higher‑level abstractions (CQRS, sagas, projections) on top of event sourcing.
- **Teams that value** compile‑time guarantees, functional programming, and minimal dependencies.

## 4. Goals (Functional Requirements)

### 4.1 Core Abstractions

- Provide **`AggregateDefinition<State, Event>`** – a pure contract with `initialState` and `reduce` (reducer).
- Provide **`CommandHandler<State, Command, Event, Error>`** – a pure function `(state, command) => Result<readonly Event[], Error>`. Domain errors are part of the return type.
- Provide **`EventStore<E>`** interface with `load` and `append` operations, enforcing optimistic concurrency and idempotency.
- Provide **`Projection<S, E>`** – a read‑model builder with `initialState` and `fold`.

### 4.2 Aggregate Lifecycle

- **`createAggregate`** – explicit creation of a new stream. Fails if stream already exists.
- **`loadAggregate`** – loads and rebuilds state from existing stream. Fails if stream does not exist.
- **`rebuildAggregate`** – low‑level synchronous rebuild from a loaded stream.

### 4.3 Command Execution

- **`executeCommand`** – orchestrates load, rebuild, handler, append, and final rebuild. Returns new state, emitted events, and last version.
- **`defineCommand`** – ergonomic wrapper that binds an `AggregateDefinition` and `CommandHandler` together.

### 4.4 Event Matching

- **`matchEvent`** – exhaustive matcher for discriminated‑union events. Compiler enforces that every event type is handled.
- **`matchEventPartial`** – non‑exhaustive matcher for projections or process managers that ignore certain events.

### 4.5 Results & Errors

- **`Result<T, E>`** type with `Ok` and `Err` constructors.
- Combinators: **`mapOk`**, **`andThen`** (async), **`andThenSync`**, **`unwrap`** (for boundaries).
- Core error types: `StreamNotFound`, `AggregateNotFound`, `AggregateAlreadyExists`, `StoreError`, `ConcurrencyConflict`, `IdempotencyViolation`. Domain errors are user‑defined.

### 4.6 Reference Implementation

- **`InMemoryEventStore<E>`** – in‑memory store for testing and local development (not production‑ready).

### 4.7 Projections

- **`project`** – pulls events from a stream and folds them into a projection state (optionally up to a specific version).

## 5. Non‑Functional Requirements

### 5.1 Performance & Determinism

- Rebuilding an aggregate from events must be O(n) where n = number of events.
- Reducers and command handlers must be pure and deterministic (same input → same output).
- The library itself **never throws**; all failures are expressed as `Result`.

### 5.2 Type Safety

- Adding a new event type to a union must cause **compile errors** on every reducer and matcher that is not updated.
- No use of `any` that leaks to user code.
- All public APIs must be strictly typed.

### 5.3 Minimalism

- The core API surface must be less than 20 functions/types (excluding combinators and helpers).
- No external runtime dependencies.
- No decorators, reflection, or code generation.

### 5.4 Infrastructure Agnosticism

- No built‑in adapters for databases, message buses, or HTTP.
- The `EventStore` interface is the only bridge to persistence.
- Snapshotting, caching, and push‑based subscriptions are **explicitly out of scope**.

### 5.5 Extensibility

- All public types and interfaces must be usable by external extensions (e.g., snapshot, saga, PostgreSQL store) without modifying the core.

## 6. Public API (v1)

### Core Primitives

- `Result<T, E>`, `Ok()`, `Err()`
- `mapOk`, `andThen`, `andThenSync`, `unwrap`
- `AnyEvent`, `AnyCommand`
- `CoreError` (discriminated union)

### Aggregate

- `AggregateDefinition<State, Event>`
- `Reducer<State, Event>`
- `createAggregate`, `loadAggregate`, `rebuildAggregate`

### Command

- `CommandHandler<State, Command, Event, Error>`
- `executeCommand`
- `defineCommand`

### Projection

- `Projection<S, E>`
- `project`

### Event Matching

- `matchEvent`, `matchEventPartial`, `EventMatcher<E, R>`

### Event Store

- `EventStore<E>` interface
- `StreamState<E>`, `EmptyStream`, `LoadedStream<E>`
- `PersistedEvent<E>`
- `InMemoryEventStore<E>` (reference)

## 7. Out of Scope (Explicitly)

- Push‑based subscriptions
- CQRS frameworks
- Sagas / process managers
- Multi‑stream transactions
- Messaging guarantees (exactly‑once, ordering across streams)
- Dependency injection
- Decorators or reflection
- Runtime schema validation
- Snapshotting (extension point)
- Automatic retry or backoff

## 8. Error Handling Model

All public functions return `Result<T, E>` where `E` is either:
- `CoreError` (technical failures: store down, concurrency, idempotency)
- A user‑defined domain error type (e.g., `InsufficientFunds`)

The calling code **must** handle both cases explicitly. The `unwrap` helper is provided only for test helpers or trust boundaries (throws on error).

## 9. Example User Journey

```ts
// 1. Define events, state, aggregate
type CartEvent = { type: "ItemAdded"; itemId: string } | { type: "CheckedOut" }
type CartState = { items: string[]; checkedOut: boolean }

const cartAggregate: AggregateDefinition<CartState, CartEvent> = {
  initialState: { items: [], checkedOut: false },
  reduce: (state, event) => matchEvent(event, {
    ItemAdded: e => ({ ...state, items: [...state.items, e.itemId] }),
    CheckedOut: () => ({ ...state, checkedOut: true })
  })
}

// 2. Define command handler
type AddItemCommand = { itemId: string }
type DomainError = "ALREADY_CHECKED_OUT"

const addItemHandler: CommandHandler<CartState, AddItemCommand, CartEvent, DomainError> =
  ({ state, command }) => {
    if (state.checkedOut) return Err("ALREADY_CHECKED_OUT")
    return Ok([{ type: "ItemAdded", itemId: command.itemId }])
  }

// 3. Create and execute (using PostgreSQL store via adapter)
const store = new PostgresEventStore<CartEvent>(dbConnection)
await createAggregate({ store, streamId: "cart-1", events: [], idempotencyKey: "create" })
const result = await executeCommand({
  store,
  aggregate: cartAggregate,
  streamId: "cart-1",
  command: { itemId: "apple" },
  idempotencyKey: "cmd-1",
  handler: addItemHandler
})
```

## 10. Success Criteria

1. A developer can build an event‑sourced aggregate with full type safety in under 50 lines of code.
2. Adding a new event type to the union causes compilation errors in all reducers and matchers that haven’t been updated.
3. No exceptions cross the library boundary; all errors are typed `Result`.
4. The core can be published as a single package with zero production dependencies.
5. External extensions (snapshots, saga, PostgreSQL store) can be written without modifying the core.
6. Performance of rebuilding an aggregate from 10,000 events is benchmarked and documented (target: <50ms for simple reducers).

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|-------------|
| Users may forget to call `createAggregate` before `executeCommand`, leading to `StreamNotFound` errors. | Clear error message and documentation; provide `defineCommand` wrapper to encourage explicit creation. |
| Concurrency conflicts require manual retry – some users expect automatic retries. | Keep core minimal; provide example retry helper in documentation. |
| No built‑in snapshotting may cause performance issues for very long streams. | Snapshot extension documented as recommended for streams >10k events. |
| Idempotency key generation pushes burden to caller. | Document best practices (UUID per command, or deterministic derived keys). |

## 12. Dependencies

- TypeScript 5.0+ (no runtime dependencies)

## 13. Future Possibilities (Not Committed)

- Official PostgreSQL / EventStoreDB adapters (separate packages)
- Snapshot extension (see separate PRD)
- Saga extension (see separate PRD)
- Testing utilities for command handlers and aggregates
