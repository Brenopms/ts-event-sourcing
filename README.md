# Typed Event Sourcing Core

A minimal, opinionated, strongly typed event-sourcing library for TypeScript.

> **If it compiles, it's correct.**

This library provides a pure functional kernel for building event-sourced aggregates — exhaustive event matching, an explicit aggregate lifecycle, a `Result`-based error model, and zero infrastructure coupling. It is not a framework; it is a foundational primitive upon which higher-level systems (CQRS, projections, messaging, sagas) can be built.

```
npm install @ts-event-sourcing/core
```

---

## Table of Contents

**Already know event sourcing?** Jump straight to the [Quick Start](#quick-start) or the [API Reference](#api-reference).

**New to event sourcing?** Start at [Why Event Sourcing?](#why-event-sourcing) and read through the [Core Concepts](#core-concepts) — the tutorial will make everything click before you write any code.

---

- [Quick Start](#quick-start) ← experienced engineers start here
- [Why Event Sourcing?](#why-event-sourcing)
- [Core Concepts](#core-concepts)
  - [Events — immutable facts](#events--immutable-facts)
  - [State & Reducers — deriving truth from history](#state--reducers--deriving-truth-from-history)
  - [Commands — expressing intent](#commands--expressing-intent)
  - [The Result Type — explicit failure, always](#the-result-type--explicit-failure-always)
  - [Aggregate Lifecycle — creation is not mutation](#aggregate-lifecycle--creation-is-not-mutation)
  - [Projections — read models from the same source of truth](#projections--read-models-from-the-same-source-of-truth)
- [Tutorial: Shopping Cart](#tutorial-shopping-cart)
- [Error Handling](#error-handling)
- [The Event Store Interface](#the-event-store-interface)
- [API Reference](#api-reference)
- [Out of Scope](#out-of-scope)
- [Design Philosophy](#design-philosophy)

---

## Quick Start

For engineers already familiar with event sourcing. Full explanations follow in [Core Concepts](#core-concepts).

**1. Define events, state, and an aggregate:**

```ts
import {
  type AggregateDefinition,
  type CommandHandler,
  matchEvent,
} from "@myorg/event-sourcing-core"

type CartEvent =
  | { type: "CartCreated"; cartId: string }
  | { type: "ItemAdded"; itemId: string; quantity: number }
  | { type: "CheckedOut" }

type CartState = {
  cartId: string
  items: Record<string, number>
  checkedOut: boolean
}

const cartAggregate: AggregateDefinition<CartState, CartEvent> = {
  initialState: { cartId: "", items: {}, checkedOut: false },
  reduce: (state, event) => matchEvent(event, {
    CartCreated:  e => ({ ...state, cartId: e.cartId }),
    ItemAdded:    e => ({
      ...state,
      items: { ...state.items, [e.itemId]: (state.items[e.itemId] ?? 0) + e.quantity }
    }),
    CheckedOut: () => ({ ...state, checkedOut: true })
  })
}
```

**2. Define command types and handlers separately:**

Domain errors are typed object unions — not strings — so you can attach structured data (e.g. which item caused a conflict).

```ts
import { type CommandHandler, Ok, Err } from "@myorg/event-sourcing-core"

type AddItemCommand = { itemId: string; quantity: number }

type CartError =
  | { type: "AlreadyCheckedOut" }
  | { type: "InvalidQuantity" }

const createCartHandler: CommandHandler<CartState, { cartId: string }, CartEvent, CartError> =
  ({ command }) => Ok([{ type: "CartCreated", cartId: command.cartId }])

const addItemHandler: CommandHandler<CartState, AddItemCommand, CartEvent, CartError> =
  ({ state, command }) => {
    if (state.checkedOut) return Err({ type: "AlreadyCheckedOut" })
    if (command.quantity <= 0) return Err({ type: "InvalidQuantity" })
    return Ok([{ type: "ItemAdded", itemId: command.itemId, quantity: command.quantity }])
  }

const checkoutHandler: CommandHandler<CartState, {}, CartEvent, CartError> =
  ({ state }) => {
    if (state.checkedOut) return Err({ type: "AlreadyCheckedOut" })
    return Ok([{ type: "CheckedOut" }])
  }
```

**3. Bind with `defineCommand`, open the stream, execute:**

`createAggregate` opens the stream with no events. The first domain event (e.g. `CartCreated`) is emitted by a command handler, keeping creation logic in the same typed pipeline as all other commands.

```ts
import {
  defineCommand,
  createAggregate,
  InMemoryEventStore,
} from "@myorg/event-sourcing-core"

const createCart = defineCommand({ aggregate: cartAggregate, handler: createCartHandler })
const addItem    = defineCommand({ aggregate: cartAggregate, handler: addItemHandler })
const checkout   = defineCommand({ aggregate: cartAggregate, handler: checkoutHandler })

const store = new InMemoryEventStore<CartEvent>()
const streamId = "cart-user-1"

// Open the stream (fails with AggregateAlreadyExists if called twice)
await createAggregate({ store, streamId, events: [], idempotencyKey: "open-cart-1" })

// Emit CartCreated via the first command
await createCart.execute({ store, streamId, command: { cartId: streamId }, idempotencyKey: "create-cart-1" })

await addItem.execute({ store, streamId, command: { itemId: "apple", quantity: 2 }, idempotencyKey: "add-apple-1" })

const result = await checkout.execute({ store, streamId, command: {}, idempotencyKey: "checkout-1" })
// result.ok === true
// result.value.state === { cartId: "cart-user-1", items: { apple: 2 }, checkedOut: true }

// Domain rejection — handler returns Err, no events are appended
const late = await addItem.execute({ store, streamId, command: { itemId: "banana", quantity: 1 }, idempotencyKey: "add-late" })
// late.ok === false
// late.error === { type: "AlreadyCheckedOut" }
```

**Key things to know:**

- `matchEvent` is exhaustive — adding a new event type without updating every matcher is a **compile error**
- `createAggregate` just opens the stream; your first domain event (e.g. `CartCreated`, `OrderPlaced`) comes from a command handler
- Domain errors are typed object unions — use `.type` to narrow them alongside `CoreError`
- `match(state, "field", { ... })` is a convenience helper for state-machine dispatch on any discriminant field (not just events) — see the [API Reference](#api-reference)
- Every function returns `Result<T, E>` — the library **never throws**
- `idempotencyKey` must be unique per command invocation; resubmitting the same key is safe (returns `IdempotencyViolation` instead of appending twice)
- `InMemoryEventStore` is for tests only; bring your own store for production by implementing `EventStore<E>`

Jump to the [API Reference](#api-reference) or read on for deeper context.

---

## Why Event Sourcing?

In a traditional system, you store the *current state* of a record in a database row. When something changes, you overwrite the row. The previous state is gone. You might keep an `updated_at` timestamp, but you've lost the *reason* it changed, the order of changes, and any intermediate states.

Event sourcing flips this: instead of storing the current state, you store the **sequence of events that produced it**. State becomes a derived value — computed by replaying events from the beginning, in order.

```
[OrderPlaced] → [ItemAdded] → [ItemAdded] → [CheckedOut]
                                                   ↓
                               fold(initialState, events) = current state
```

Think of it like a bank account. A bank doesn't store your balance as a single number it overwrites. It stores every transaction — deposits, withdrawals, transfers — and your balance is whatever those transactions sum to. If you want to know your balance last Tuesday, you replay transactions up to that point.

This model gives you several things for free:

- **A complete audit log.** Every change is recorded as a fact, with its full context.
- **Deterministic replay.** You can always reconstruct any past state from scratch.
- **Time travel.** Load state as it existed at any previous version — useful for debugging, reporting, and compliance.
- **Decoupled read models.** You can build multiple views of the same data (projections) and rebuild them any time — they're always derived from the authoritative event history.
- **Testable domain logic.** Because state is just a fold over events, your business rules can be tested with plain arrays — no database required.

The difficulty is doing this in a way that's type-safe, doesn't let you accidentally forget to handle a new event, and keeps infrastructure out of your domain logic. That's what this library solves.

---

## Core Concepts

### Events — immutable facts

An event is something that **has already happened**. It is not a request or an intention — it is a record of a fact. Because it has already happened, it cannot be changed or undone. New events can be appended, but past events are permanent.

In this library, events are plain TypeScript discriminated unions:

```ts
type CartEvent =
  | { type: "ItemAdded"; itemId: string; quantity: number }
  | { type: "ItemRemoved"; itemId: string }
  | { type: "CheckedOut" }
```

No classes, no base types, no inheritance. Discriminated unions give you maximal type safety and excellent serialization characteristics — they're just plain objects that JSON round-trip cleanly.

The `type` field is the discriminant. The library uses it to route events to the correct handler, and TypeScript uses it to narrow the payload type automatically inside each case.

Events are **append-only**: once written, they are never modified or deleted.

---

### State & Reducers — deriving truth from history

State is never stored directly. It is always **computed** by folding a sequence of events through a pure reducer:

```ts
type CartState = {
  items: Record<string, number>  // itemId → quantity
  checkedOut: boolean
}

const reduce = (state: CartState, event: CartEvent): CartState =>
  matchEvent(event, {
    ItemAdded: e => ({
      ...state,
      items: { ...state.items, [e.itemId]: (state.items[e.itemId] ?? 0) + e.quantity }
    }),
    ItemRemoved: e => {
      const { [e.itemId]: _, ...rest } = state.items
      return { ...state, items: rest }
    },
    CheckedOut: () => ({ ...state, checkedOut: true })
  })
```

Notice `matchEvent` — this is the library's **exhaustive event matcher**. Unlike a `switch` statement, it is an object where every key in your event union must appear. If you add a new event type and forget to update a reducer, the project won't compile. This is one of the library's central guarantees.

The reducer must be:
- **Pure** — no side effects, no I/O, no randomness
- **Deterministic** — same inputs always produce the same output
- **Total** — every possible event type is handled (enforced at compile time)

A practical consequence: you can unit test your entire domain model by passing arrays of events and asserting on the resulting state, without any mocks, databases, or infrastructure.

> **Common mistake for newcomers:** It can be tempting to store state somewhere and update it in place. Resist this. State is always the *output* of replaying events — never the source of truth. The events are the source of truth.

---

### Commands — expressing intent

A command represents **intent**: a request to do something that hasn't happened yet. Unlike events (facts about the past), commands can be **rejected**.

A command handler is a pure function that receives the current aggregate state and a command, evaluates the domain rules, and either approves the command (returning a list of events to append) or rejects it (returning a domain error).

Define your handler type explicitly using `CommandHandler<State, Command, Event, Error>`, then pass it to `defineCommand`. This keeps the type signature readable and makes the handler independently testable:

```ts
import { type CommandHandler, Ok, Err } from "@myorg/event-sourcing-core"

type IssuePrescriptionCommand = {
  prescriptionId: string
  drug: string
  dosage: string
  startDate: Date
  endDate: Date
}

// Domain errors are typed object unions — not strings.
// This lets you attach structured context (e.g. which allergen caused a conflict).
type PatientError =
  | { type: "AllergyConflict"; drug: string; allergen: string }
  | { type: "InvalidPrescriptionDates" }
  | { type: "DuplicatePrescriptionId" }

const issuePrescriptionHandler: CommandHandler<
  PatientState,
  IssuePrescriptionCommand,
  PatientEvent,
  PatientError
> = ({ state, command }) => {
  if (state.prescriptions.some(p => p.prescriptionId === command.prescriptionId))
    return Err({ type: "DuplicatePrescriptionId" })

  const allergy = state.allergies.find(a =>
    command.drug.toLowerCase().includes(a.allergen.toLowerCase())
  )
  if (allergy)
    return Err({ type: "AllergyConflict", drug: command.drug, allergen: allergy.allergen })

  if (command.endDate <= command.startDate)
    return Err({ type: "InvalidPrescriptionDates" })

  return Ok([{ type: "PrescriptionIssued", patientId: state.patientId, ...command }])
}
```

Command handlers:
- Are **pure functions** — no database calls, no side effects, no network I/O
- Return `Ok(events)` on success or `Err(domainError)` on rejection
- Can return an empty event list `Ok([])` as a deliberate no-op
- Can only emit events from your defined event union (enforced by the compiler)

The separation of commands (intent) from events (facts) is deliberate. It keeps your domain rules in pure functions that are trivial to test, and lets the infrastructure layer handle persistence independently.

---

### The Result Type — explicit failure, always

This library **never throws**. All failures — technical and domain — are expressed as typed `Result` values:

```ts
type Result<T, E> =
  | { ok: true;  value: T }
  | { ok: false; error: E }
```

You construct results with `Ok` and `Err`:

```ts
return Ok([{ type: "ItemAdded", itemId: "apple", quantity: 1 }])
return Err("ALREADY_CHECKED_OUT")
```

Every public function in this library returns a `Result`. You must handle it explicitly — there's no hidden exception that bypasses your error handling, and there's no `undefined` slipping through.

You can chain fallible operations using combinators that short-circuit on the first error, keeping the happy path linear and readable:

```ts
// mapOk — transform a success value without introducing a new failure mode
const doubled = mapOk(Ok(21), x => x * 2)  // Ok(42)

// andThen — chain an async step that may itself fail
const result = await andThen(loadResult, async state => executeNextStep(state))

// andThenSync — same, but synchronous
const result = andThenSync(parseResult, parsed => validate(parsed))
```

The `unwrap` helper throws on error. It exists only for test assertions or trust boundaries where you've structurally guaranteed success — not for routine error handling.

> **Why not exceptions?** Exceptions are invisible in TypeScript — a function's signature gives you no indication it might throw or what it might throw with. `Result` makes failure part of the type contract. You can't accidentally forget to handle it.

---

### Aggregate Lifecycle — creation is not mutation

An **aggregate** is the unit of consistency in an event-sourced system. It owns a single stream of events and enforces domain invariants across all changes to that stream. One aggregate = one stream.

A critical design choice of this library is that **opening a stream and emitting the first domain event are separate concerns**:

- **`createAggregate`** — opens a new, empty stream. Fails with `AggregateAlreadyExists` if the stream already exists. Does not run any domain logic.
- **First command** — your first domain event (e.g. `OrderPlaced`, `PatientRegistered`) is emitted by a command handler, exactly like any other command. This keeps creation logic in the same typed, testable pipeline.
- **`executeCommand`** (via `defineCommand`) — applies subsequent commands to the existing stream. Fails with `StreamNotFound` if the stream doesn't exist yet.
- **`loadAggregate`** — loads and rebuilds state from an existing stream. Fails with `AggregateNotFound` if the stream is empty (i.e. `createAggregate` was called but no commands have run yet).

```ts
// 1. Open the stream — no events, no domain logic
await createAggregate({ store, streamId: "order-456", events: [], idempotencyKey: "open-order-456" })

// 2. Emit the first domain event via a command handler
await placeOrder.execute({
  store,
  streamId: "order-456",
  command: { orderId: "order-456", customerId: "cust-1", items: [...] },
  idempotencyKey: "place-order-456"
})

// 3. Continue with subsequent commands
await confirmPayment.execute({ store, streamId: "order-456", command: { transactionId: "txn-abc" }, idempotencyKey: "confirm-456" })
```

This explicitness prevents a whole class of subtle bugs where a missing aggregate silently creates a phantom one. If you try to execute a command on a stream that was never opened, you get a clear `StreamNotFound` error immediately.

**`rebuildAggregate`** is a lower-level helper that folds an already-loaded stream into state synchronously. Most callers won't need it directly, but it's exported for snapshot extensions and testing reducers in isolation.

---

### Projections — read models from the same source of truth

A **projection** is a read model — a view of your data shaped for querying rather than for enforcing invariants. Projections are derived from the same event stream as aggregates, but they're intentionally more relaxed:

- They can **ignore events** they don't care about
- They can **denormalize** data across multiple fields
- They don't enforce domain invariants
- They can be rebuilt any time from the event history

```ts
type OrderSummary = { status: string; total: number }

const orderSummaryProjection: Projection<OrderSummary, OrderEvent> = {
  initialState: { status: "pending", total: 0 },
  fold: (state, event) => {
    if (event.type === "OrderPlaced")    return { ...state, total: event.total }
    if (event.type === "OrderShipped")  return { ...state, status: "shipped" }
    if (event.type === "OrderCancelled") return { ...state, status: "cancelled" }
    return state  // ignore other events
  }
}

const result = await project({ store, streamId: "order-42", projection: orderSummaryProjection })
```

Note that projections use `fold` instead of `reduce` — a deliberate naming distinction signalling that they're read-side constructs, not aggregate reducers. The `matchEventPartial` helper is well-suited for projection folds where only some events are relevant.

Projections in this library are **pull-based**: you call `project` to rebuild them on demand. Push-based subscriptions (reacting to new events in real time) are out of scope for the core — that belongs in an adapter layer.

---

## Tutorial: Shopping Cart

This section walks through building a complete shopping cart aggregate from scratch — events, state, aggregate definition, commands, and projections — using the library's patterns step by step.

### 1. Define your events and state

Start by modelling what can happen in your domain as a discriminated union of events, and what the resulting state looks like:

```ts
type CartEvent =
  | { type: "ItemAdded"; itemId: string; quantity: number }
  | { type: "ItemRemoved"; itemId: string }
  | { type: "CheckedOut" }

type CartState = {
  items: Record<string, number>  // itemId → quantity
  checkedOut: boolean
}
```

---

### 2. Define your aggregate

An `AggregateDefinition` is the pure data-evolution contract: an initial state and a reducer that describes how each event transforms the state.

```ts
import { AggregateDefinition, matchEvent } from "@myorg/event-sourcing-core"

const cartAggregate: AggregateDefinition<CartState, CartEvent> = {
  initialState: { items: {}, checkedOut: false },
  reduce: (state, event) => matchEvent(event, {
    ItemAdded: e => ({
      ...state,
      items: { ...state.items, [e.itemId]: (state.items[e.itemId] ?? 0) + e.quantity }
    }),
    ItemRemoved: e => {
      const { [e.itemId]: _, ...rest } = state.items
      return { ...state, items: rest }
    },
    CheckedOut: () => ({ ...state, checkedOut: true })
  })
}
```

`matchEvent` is the exhaustive matcher — if you later add `{ type: "DiscountApplied" }` to `CartEvent`, every call to `matchEvent` that doesn't handle it will fail to compile.

---

### 3. Define command handlers

One handler per command. Each handler is a pure function — no I/O, just state + command → events or error.

```ts
import { CommandHandler, Ok, Err } from "@myorg/event-sourcing-core"

type CartError = "ALREADY_CHECKED_OUT" | "INVALID_QUANTITY" | "ITEM_NOT_IN_CART"

const addItemHandler: CommandHandler<CartState, { itemId: string; quantity: number }, CartEvent, CartError> =
  ({ state, command }) => {
    if (state.checkedOut) return Err("ALREADY_CHECKED_OUT")
    if (command.quantity <= 0) return Err("INVALID_QUANTITY")
    return Ok([{ type: "ItemAdded", itemId: command.itemId, quantity: command.quantity }])
  }

const checkoutHandler: CommandHandler<CartState, Record<never, never>, CartEvent, CartError> =
  ({ state }) => {
    if (state.checkedOut) return Err("ALREADY_CHECKED_OUT")
    return Ok([{ type: "CheckedOut" }])
  }
```

---

### 4. Bind with `defineCommand` and execute

`defineCommand` binds an aggregate and a handler into a reusable unit. At every call site, you provide only infrastructure: the store, a stream ID, and an idempotency key.

```ts
import { defineCommand, createAggregate, InMemoryEventStore } from "@myorg/event-sourcing-core"

const addItem = defineCommand({ aggregate: cartAggregate, handler: addItemHandler })
const checkout = defineCommand({ aggregate: cartAggregate, handler: checkoutHandler })

const store = new InMemoryEventStore<CartEvent>()

// createAggregate opens the stream — this is a required first step.
// Calling executeCommand on a non-existent stream returns StreamNotFound.
await createAggregate({
  store,
  streamId: "cart-user-1",
  events: [],
  idempotencyKey: "create-cart-user-1"
})

await addItem.execute({
  store,
  streamId: "cart-user-1",
  command: { itemId: "apple", quantity: 2 },
  idempotencyKey: "add-apple-1"
})

await addItem.execute({
  store,
  streamId: "cart-user-1",
  command: { itemId: "banana", quantity: 1 },
  idempotencyKey: "add-banana-1"
})

const result = await checkout.execute({
  store,
  streamId: "cart-user-1",
  command: {},
  idempotencyKey: "checkout-cart-user-1"
})

if (result.ok) {
  console.log(result.value.state)
  // { items: { apple: 2, banana: 1 }, checkedOut: true }
  console.log(result.value.events)
  // [{ type: "CheckedOut" }]
}

// Domain rejection — handler returns Err, no events are appended
const late = await addItem.execute({
  store,
  streamId: "cart-user-1",
  command: { itemId: "cherry", quantity: 1 },
  idempotencyKey: "add-cherry-late"
})

console.log(late.ok)     // false
console.log(late.error)  // "ALREADY_CHECKED_OUT"
```

What happens inside `execute`:

1. Load the event stream from the store
2. Fold events through `cartAggregate.reduce` to rebuild current state
3. Call the command handler with `{ state, command }`
4. If `Ok(events)` — append events with optimistic concurrency control
5. Rebuild post-append state and return `{ state, events, lastVersion }`

If any step fails (store error, concurrency conflict, domain rejection), the remaining steps don't execute and the error is returned as a `Result`.

The `idempotencyKey` must be unique per command invocation. Resubmitting the same key is safe — the store returns `IdempotencyViolation` instead of appending duplicate events. Use a UUID per invocation, or a deterministic key derived from your inputs.

---

### 5. Build a projection

Projections are read models shaped for querying. They share the same event stream but don't enforce invariants. Use `matchEventPartial` to handle only the events you care about:

```ts
import { Projection, project, matchEventPartial } from "@myorg/event-sourcing-core"

type CartSummary = { itemCount: number; checkedOut: boolean }

const cartSummaryProjection: Projection<CartSummary, CartEvent> = {
  initialState: { itemCount: 0, checkedOut: false },
  fold: (state, event) =>
    matchEventPartial(event, {
      ItemAdded:  e => ({ ...state, itemCount: state.itemCount + e.quantity }),
      CheckedOut: () => ({ ...state, checkedOut: true })
      // ItemRemoved is intentionally ignored — not relevant to this view
    }) ?? state
}

const summary = await project({
  store,
  streamId: "cart-user-1",
  projection: cartSummaryProjection
})
// summary.value.state === { itemCount: 3, checkedOut: true }

// Time-travel: project up to version 2 (before checkout)
const pastSummary = await project({
  store,
  streamId: "cart-user-1",
  projection: cartSummaryProjection,
  options: { toVersion: 2 }
})
// pastSummary.value.state === { itemCount: 3, checkedOut: false }
```

---

## Error Handling

All public functions return `Result<T, E>`. Errors fall into two categories:

**Core (technical) errors** — returned by infrastructure operations:

| Error | Meaning |
|---|---|
| `StreamNotFound` | Tried to load a stream that doesn't exist |
| `AggregateNotFound` | Stream exists but has no events (never created) |
| `AggregateAlreadyExists` | Called `createAggregate` on an existing stream |
| `ConcurrencyConflict` | Optimistic concurrency check failed (version mismatch) |
| `IdempotencyViolation` | Same idempotency key used with different events |
| `StoreError` | Generic store-level failure |

**Domain errors** — returned by your command handlers. These are fully user-defined and typed as generic parameters. The compiler ensures you handle both technical and domain errors at every call site.

```ts
const result = await addItem.execute({ ... })

if (!result.ok) {
  switch (result.error) {
    case "ALREADY_CHECKED_OUT":
      // handle domain rejection
      break
    default:
      // result.error is CoreError — handle technical failure
  }
}
```

---

## The Event Store Interface

The library is infrastructure-agnostic. The only bridge to persistence is the `EventStore<E>` interface:

```ts
interface EventStore<E extends AnyEvent> {
  load(params: {
    streamId: string
    toVersion?: number
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

The library ships with `InMemoryEventStore<E>` for testing and local development. For production, implement this interface backed by your storage of choice (PostgreSQL, EventStoreDB, DynamoDB, etc.) — all guarantees hold regardless of the backing store.

---

## API Reference

### Core primitives

| Export | Description |
|---|---|
| `Result<T, E>` | The fundamental result type |
| `Ok(value)` | Construct a success result |
| `Err(error)` | Construct a failure result |
| `mapOk(result, fn)` | Transform a success value |
| `andThen(result, fn)` | Chain an async fallible step |
| `andThenSync(result, fn)` | Chain a synchronous fallible step |
| `unwrap(result)` | Extract the value or throw (tests/boundaries only) |
| `CoreError` | Discriminated union of all technical errors |

### Event matching

| Export | Description |
|---|---|
| `matchEvent(event, matcher)` | Exhaustive event matcher — compiler enforces all cases |
| `matchEventPartial(event, matcher)` | Non-exhaustive matcher — for projections or process managers |
| `EventMatcher<E, R>` | The exhaustive matcher object type |

### Aggregate

| Export | Description |
|---|---|
| `AggregateDefinition<S, E>` | Contract: `initialState` + `reduce` |
| `Reducer<S, E>` | Type alias for `(state: S, event: E) => S` |
| `createAggregate(params)` | Create a new event stream; fails if already exists |
| `loadAggregate(params)` | Load and rebuild state from an existing stream |
| `rebuildAggregate(params)` | Low-level: fold a `LoadedStream` into state synchronously |

### Commands

| Export | Description |
|---|---|
| `CommandHandler<S, C, E, Err>` | Type for a pure command handler function |
| `executeCommand(params)` | Orchestrates load → handler → append → rebuild |
| `defineCommand(params)` | Ergonomic wrapper binding aggregate + handler |

### Projections

| Export | Description |
|---|---|
| `Projection<S, E>` | Read model definition: `initialState` + `fold` |
| `project(params)` | Folds events from a stream into a projection state |

### Event Store

| Export | Description |
|---|---|
| `EventStore<E>` | Interface — the only persistence boundary |
| `StreamState<E>` | `EmptyStream \| LoadedStream<E>` |
| `PersistedEvent<E>` | An event with a `version` number assigned by the store |
| `InMemoryEventStore<E>` | Reference implementation for testing |

---

## Out of Scope

The following are intentionally not part of this library:

- Push-based subscriptions and event streaming
- CQRS frameworks or query buses
- Sagas and process managers
- Multi-stream transactions
- Automatic retry or backoff
- Dependency injection or decorators
- Runtime schema validation
- Snapshotting (recommended as an external extension for streams > 10k events)

These concerns belong in adapters and extensions built on top of this core. All public types are designed to be used by such extensions without modifying the library itself.

---

## Design Philosophy

**Functional core, imperative shell.** Domain logic — reducers and command handlers — is pure and deterministic. Side effects live in store adapters. You can test every domain decision without touching a database.

**Explicit over implicit.** There is no "upsert" aggregate, no magic default case in a switch, no silent swallowing of errors. `createAggregate` and `loadAggregate` are separate operations because creation and mutation are semantically different.

**The compiler is your test suite.** Adding a new event type to a union will cause compile errors everywhere it isn't handled — reducers, matchers, and command handlers all participate. Exhaustiveness is structural, not a discipline.

**No runtime surprises.** The library never throws across its boundary. Every failure mode — concurrency conflicts, store errors, idempotency violations, domain rejections — is a typed `Result` value you must handle explicitly.