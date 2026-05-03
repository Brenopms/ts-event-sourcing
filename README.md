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
- [Pitfalls & Best Practices](#pitfalls--best-practices)
  - [Never put side effects or non-determinism in reducers or command handlers](#-never-put-side-effects-or-non-determinism-in-reducers-or-command-handlers)
  - [Never put I/O inside command handlers](#-never-put-io-inside-command-handlers)
  - [Don't use InMemoryEventStore in production](#-dont-use-inmemoryeventstore-in-production)
  - [Don't use unwrap outside of tests](#-dont-use-unwrap-outside-of-tests)
  - [Handle ConcurrencyConflict with a retry](#-handle-concurrencyconflict-with-a-retry)
  - [Use structured object unions for domain errors](#-use-structured-object-unions-for-domain-errors)
  - [Use match for state-machine dispatch](#-use-match-for-state-machine-dispatch)
  - [Name events as past-tense facts](#-name-events-as-past-tense-facts-not-commands-or-crud)
  - [Choose idempotency keys deliberately](#-choose-idempotency-keys-deliberately)
  - [Plan for long-lived streams](#-plan-for-long-lived-streams)
  - [Plan for event schema evolution](#-plan-for-event-schema-evolution)
- [Using the Library in the Real World](#using-the-library-in-the-real-world)
  - [Implementing an EventStore adapter](#implementing-an-eventstore-adapter)
  - [Modeling aggregate boundaries](#modeling-aggregate-boundaries)
  - [Modeling projections in a real application](#modeling-projections-in-a-real-application)
  - [Wiring it into an HTTP API](#wiring-it-into-an-http-api)
  - [Testing strategy](#testing-strategy)
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
} from "@ts-event-sourcing/core"

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
import { type CommandHandler, Ok, Err } from "@ts-event-sourcing/core"

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
} from "@ts-event-sourcing/core"

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
import { type CommandHandler, Ok, Err } from "@ts-event-sourcing/core"

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

An important constraint: **`project` reads a single stream**. This means projections built with this library answer per-entity questions — "what is the current state of order 42?" — not cross-entity questions like "how many orders are in the Shipped status?" Cross-aggregate views require consuming events from all streams, which is a job for a separate subscription layer outside the core.

```ts
// ✅ Good — a question about one order's own history
type OrderLifecycle = {
  placedAt: Date
  statusHistory: Array<{ status: string; at: Date }>
}

const orderLifecycleProjection: Projection<OrderLifecycle, OrderEvent> = {
  initialState: { placedAt: new Date(0), statusHistory: [] },
  fold: (state, event) => {
    if (event.type === "OrderPlaced")    return { ...state, placedAt: new Date() }
    if (event.type === "OrderShipped")   return { ...state, statusHistory: [...state.statusHistory, { status: "Shipped",   at: new Date() }] }
    if (event.type === "OrderDelivered") return { ...state, statusHistory: [...state.statusHistory, { status: "Delivered", at: new Date() }] }
    return state
  }
}

// ❌ Wrong — counts across all orders cannot come from one stream
type OrderStats = { pending: number; shipped: number; delivered: number }
// A single order stream will always produce counts of 0 or 1 for each status.
// Stats like this need a cross-stream subscription layer, not project().
```

Note that projections use `fold` instead of `reduce` — a deliberate naming distinction signalling that they're read-side constructs, not aggregate reducers.

**Choosing between `matchEvent` and `matchEventPartial` in projections** is a tradeoff worth making deliberately:

- **`matchEvent` (exhaustive):** Adding a new event type causes a compile error in every projection that hasn't been updated. You can't silently miss a new event the projection *should* care about — but you're forced to add explicit no-op cases for events you don't care about.
- **`matchEventPartial` (non-exhaustive):** New events are silently ignored. Less ceremony for events the projection genuinely doesn't need, but you have to remember to revisit projections when you add new event types.

A reasonable convention: use `matchEvent` in projections where correctness is critical (e.g. financial totals, audit logs), and `matchEventPartial` where the projection is additive and missing a new event type would be harmless.

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
import { AggregateDefinition, matchEvent } from "@ts-event-sourcing/core"

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
import { CommandHandler, Ok, Err } from "@ts-event-sourcing/core"

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
import { defineCommand, createAggregate, InMemoryEventStore } from "@ts-event-sourcing/core"

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
import { Projection, project, matchEventPartial } from "@ts-event-sourcing/core"

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

Because both domain errors and `CoreError` are discriminated object unions, you narrow on `.type` in a single switch:

```ts
const result = await addItem.execute({ ... })

if (!result.ok) {
  switch (result.error.type) {
    // Domain errors — defined by your application
    case "AlreadyCheckedOut":
      return res.status(409).json({ error: "Cart is already checked out" })
    case "InvalidQuantity":
      return res.status(400).json({ error: "Quantity must be greater than zero" })

    // CoreError — technical failures from the library
    case "ConcurrencyConflict":
      return res.status(409).json({ error: "Concurrent modification — please retry" })
    case "StreamNotFound":
      return res.status(404).json({ error: "Cart not found" })
    default:
      return res.status(500).json({ error: "Internal error" })
  }
}
```

TypeScript narrows `result.error` fully inside each case — including any structured payload you attached to the domain error (e.g. `result.error.allergen` inside a `case "AllergyConflict"` branch).

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

### Matching helpers

| Export | Description |
|---|---|
| `matchEvent(event, matcher)` | Exhaustive event matcher — compiler enforces all cases |
| `matchEventPartial(event, matcher)` | Non-exhaustive matcher — for projections that intentionally ignore some events |
| `match(obj, key, matcher)` | Exhaustive matcher on any discriminant field of any object — not just events. Use this for state-machine dispatch in command handlers (e.g. `match(state, "status", { ... })`) |
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
| `CommandHandler<S, C, E, Err>` | Type for a pure command handler function. Use `never` as the `Err` parameter for handlers that structurally cannot return a domain error — e.g. `CommandHandler<State, PlaceOrderCommand, OrderEvent, never>`. The handler can then only call `Ok(...)` and the compiler enforces this. |
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

## Pitfalls & Best Practices

### ❌ Never put side effects or non-determinism in reducers or command handlers

A reducer **must** be a pure function. Given the same sequence of events, it must always produce the same state — no exceptions. This guarantee is what makes replay, time travel, and testability possible.

The most common violation is calling `new Date()` or `Math.random()` inside a reducer. This breaks determinism: replaying an old event tomorrow produces different state than replaying it today.

```ts
// ❌ Wrong — new Date() in a reducer is non-deterministic
reduce: (state, event) => matchEvent(event, {
  EncounterStarted: (e) => ({
    ...state,
    currentEncounter: { startedAt: new Date() }  // breaks replay!
  })
})

// ✅ Correct — the reducer reads what the event already contains
reduce: (state, event) => matchEvent(event, {
  EncounterStarted: (e) => ({
    ...state,
    currentEncounter: { startedAt: e.startedAt }  // deterministic ✓
  })
})
```

**Command handlers** are less strict — they run once when a command is accepted, not on every replay. So calling `new Date()` in a handler isn't wrong in the same way, but it still has a real cost: **the handler becomes impossible to unit test deterministically**. You can't assert on the exact event payload without mocking the system clock.

The better pattern is to accept the timestamp through the command so the caller controls it — `new Date()` in production, a fixed value in tests:

```ts
// ❌ Harder to test — timestamp is generated inside the handler
const startEncounterHandler: CommandHandler<...> = ({ command }) =>
  Ok([{ type: "EncounterStarted", startedAt: new Date(), ...command }])

// ✅ Fully deterministic and testable — timestamp comes in via the command
type StartEncounterCommand = { encounterId: string; reason: string; startedAt: Date }

const startEncounterHandler: CommandHandler<...> = ({ command }) =>
  Ok([{ type: "EncounterStarted", startedAt: command.startedAt, ...command }])

// In production:
await startEncounter.execute({ command: { ..., startedAt: new Date() }, ... })

// In tests — full control, no clock mocking needed:
await startEncounter.execute({ command: { ..., startedAt: new Date("2024-01-01") }, ... })
```

The rule: **anything that reads the outside world (clock, random, network) belongs in the caller**, not in a handler or reducer.

---

### ❌ Never put I/O inside command handlers

Command handlers are pure functions — they receive state and a command, and return events or an error. They must not call databases, external APIs, or message queues.

```ts
// ❌ Wrong — fetching inside a command handler
const handler: CommandHandler<...> = async ({ state, command }) => {
  const price = await fetchPriceFromApi(command.sku)  // side effect!
  return Ok([{ type: "ItemAdded", price }])
}

// ✅ Correct — fetch before calling execute, pass data in via the command
const price = await fetchPriceFromApi(command.sku)
await addItem.execute({ store, streamId, command: { sku: command.sku, price }, idempotencyKey })
```

If a handler needs external data, resolve it before calling `execute` and include it in the command payload. The handler stays pure; the caller owns the I/O.

---

### ❌ Don't use `InMemoryEventStore` in production

`InMemoryEventStore` is a reference implementation for testing and local development. It has no persistence, no durability guarantees, and will lose all data on process restart.

For production, implement the `EventStore<E>` interface backed by a real store — PostgreSQL, EventStoreDB, DynamoDB, or similar. The interface is intentionally small (just `load` and `append`), and all library guarantees hold regardless of the backing store.

---

### ❌ Don't use `unwrap` outside of tests

`unwrap` throws on error. It exists as a convenience for test assertions and trust boundaries — not for production error handling. Using it in application code defeats the entire point of the `Result` type.

```ts
// ❌ Wrong — silently throws on any error in production
const { state } = unwrap(await addItem.execute(...))

// ✅ Correct — handle both cases explicitly
const result = await addItem.execute(...)
if (!result.ok) {
  // handle result.error — it's typed, the compiler knows what it can be
  return
}
const { state } = result.value
```

---

### ✅ Handle `ConcurrencyConflict` with a retry

When two processes try to append to the same stream simultaneously, one will get a `ConcurrencyConflict` error (optimistic concurrency). The library does not retry automatically — this is a deliberate choice to keep the core minimal. You should handle it at the call site:

```ts
async function executeWithRetry<T>(fn: () => Promise<Result<T, CoreError>>, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await fn()
    if (result.ok) return result
    if (result.error.type !== "ConcurrencyConflict") return result  // don't retry other errors
  }
  return Err({ type: "StoreError", cause: "Max retries exceeded" })
}

await executeWithRetry(() =>
  addItem.execute({ store, streamId, command, idempotencyKey })
)
```

High-contention aggregates (e.g. shared counters) are a signal to reconsider your aggregate boundary — event sourcing works best when each aggregate is owned by one actor at a time.

---

### ✅ Use structured object unions for domain errors

Domain errors should be typed object unions, not plain strings. Object unions let you attach structured context alongside the error type — useful for logging, user-facing messages, and error recovery.

```ts
// ❌ Avoid — strings carry no structured data
type CartError = "ALREADY_CHECKED_OUT" | "ALLERGY_CONFLICT"

// ✅ Prefer — objects can carry context
type PatientError =
  | { type: "AllergyConflict"; drug: string; allergen: string }
  | { type: "DuplicatePrescriptionId" }
  | { type: "InvalidPrescriptionDates" }

// At the call site, TypeScript narrows the payload for you
if (!result.ok && result.error.type === "AllergyConflict") {
  console.warn(`Cannot prescribe ${result.error.drug} — patient is allergic to ${result.error.allergen}`)
}
```

### ✅ Use `match` for state-machine dispatch

When a command handler's logic branches entirely on a single state field (e.g. an order's `status`), the `match` helper produces exhaustive, readable dispatch with no fallthrough risk — the same guarantee `matchEvent` provides for events, but applied to any discriminant field on any object:

```ts
import { match } from "@ts-event-sourcing/core"

const shipOrderHandler: CommandHandler<OrderState, ShipOrderCommand, OrderEvent, OrderError> =
  ({ state, command }) =>
    match(state, "status", {
      Confirmed: () => Ok([{ type: "OrderShipped", orderId: state.orderId, trackingNumber: command.trackingNumber }]),
      Pending:   () => Err({ type: "CannotShipWithoutPayment" }),
      Shipped:   () => Err({ type: "OrderAlreadyShipped" }),
      Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
      Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
    })
```

Adding a new status value to the union without updating this matcher is a compile error. This pattern is especially valuable when multiple commands operate on the same state machine.

**Two caveats to be aware of:**
 
Using a `_` default case causes the return type to become `unknown` — TypeScript can't independently resolve the specific-case and default-case types at the call site. If you need a typed result, use an exhaustive matcher instead. If you do need `_`, cast the return value:
 
```ts
// ❌ Result is `unknown` when _ is present
const result = match(state, "status", {
  Pending: () => Ok(...),
  _: () => Err({ type: "InvalidStatus" as const }),
})
 
// ✅ Cast restores full type safety
const result = match(state, "status", {
  Pending: () => Ok(...),
  _: () => Err({ type: "InvalidStatus" as const }),
}) as Result<readonly OrderEvent[], OrderError>
```
 
When passing a plain interface variable (rather than a discriminated union parameter), TypeScript may infer `T` as the concrete member type rather than the full union, causing the other case keys to appear invalid. Fix it with an `as` cast on the argument:
 
```ts
const s: Shape = { kind: "circle", radius: 5 }
 
// ❌ TypeScript infers T as the concrete circle type — "rect" key rejected
match(s, "kind", { circle: ..., rect: ... })
 
// ✅ Cast forces T to be the full union
match(s as Shape, "kind", { circle: ..., rect: ... })
```
 
This second caveat rarely comes up inside command handlers, where `state` is already typed as the full union from the function signature.

---

### ✅ Name events as past-tense facts, not commands or CRUD

Events record what happened, not what was requested or what data changed. The naming should reflect this.

```ts
// ❌ Avoid — sounds like a command
type OrderEvent = "ShipOrder" | "CancelOrder"

// ❌ Avoid — sounds like a database operation
type OrderEvent = "OrderUpdated" | "OrderDeleted"

// ✅ Prefer — unambiguous facts in the past tense
type OrderEvent =
  | { type: "OrderPlaced" }
  | { type: "OrderShipped" }
  | { type: "OrderCancelled" }
```

Good event names make the event log readable as a narrative: `OrderPlaced → PaymentConfirmed → OrderShipped → OrderDelivered`.

---

### ✅ Choose idempotency keys deliberately

Every command execution requires an `idempotencyKey`. Resubmitting the same key is safe — the store will detect the duplicate and return `IdempotencyViolation` instead of appending twice. Choose your key strategy based on the context:

```ts
// For user-initiated actions: generate a UUID at the boundary (e.g. API handler)
// and pass it through — so retrying the HTTP request replays the same key
const idempotencyKey = req.headers["idempotency-key"] ?? crypto.randomUUID()

// For deterministic flows (e.g. a migration or a scheduled job):
// derive the key from stable inputs so it's naturally idempotent
const idempotencyKey = `migrate-order-${orderId}-v2`
```

Never generate the key inside a retry loop — that defeats the purpose and will append duplicate events.

---

### ✅ Plan for event schema evolution

Events are permanent and append-only. Once `{ type: "OrderPlaced", items: [...] }` is in the store, it's there forever. This means **you can never safely rename an event's type string or remove a field that old events already contain** — the reducer must still handle the original shape when replaying historical events.

This is one of the most practically painful parts of running an event-sourced system long-term, and it requires a deliberate strategy from the start.

**Option 1: Version event type names.** When an event's shape needs to change, introduce a new type rather than modifying the old one. Keep the old case in your reducer so historical events still replay correctly:

```ts
type OrderEvent =
  | { type: "OrderPlaced";    customerId: string; items: string[] }                            // original
  | { type: "OrderPlaced_v2"; customerId: string; items: OrderItem[]; total: number }          // new shape

const orderAggregate: AggregateDefinition<OrderState, OrderEvent> = {
  reduce: (state, event) => matchEvent(event, {
    OrderPlaced:    e => ({ ...state, items: e.items.map(sku => ({ sku, quantity: 1 })), total: 0 }),  // backfill defaults
    OrderPlaced_v2: e => ({ ...state, items: e.items, total: e.total }),
    // ...
  })
}
```

**Option 2: Upcast at the store adapter boundary.** Transform old event shapes into the current shape inside your `EventStore.load` implementation, before they reach the reducer. The reducer only ever sees the current shape:

```ts
// Inside PostgresEventStore.load, after fetching rows:
const events = rows.map(row => {
  const raw = JSON.parse(row.payload)
  // Upcast legacy shape → current shape
  if (raw.type === "OrderPlaced" && !("total" in raw)) {
    return { ...raw, type: "OrderPlaced_v2", total: 0, items: raw.items.map((sku: string) => ({ sku, quantity: 1 })) }
  }
  return raw
})
```

Upcasting keeps the reducer clean but puts migration logic in infrastructure code. Version-naming keeps everything visible in the type system but accumulates old cases over time. Most real systems use both: versioning for breaking structural changes, upcasting for minor field additions.

Either way: treat renaming or removing a field as a **breaking change** that requires a migration plan, and never rely on the assumption that all stored events have the current shape.

---

### ✅ Plan for long-lived streams

Replaying a stream with 10,000 events is fast for simple reducers (target: <50ms), but unbounded streams will eventually become a performance concern. Plan for this before you need it:

- **Snapshotting** — periodically checkpoint the computed state so replay starts from the snapshot rather than event zero. This is out of scope for the core but is a supported extension pattern; all public types are designed to accommodate it.
- **Aggregate boundaries** — if a single stream grows very large, it may be a sign the aggregate is doing too much. Consider whether it should be split into finer-grained streams.
- As a rule of thumb: if a stream routinely exceeds 10,000 events, implement snapshotting.

---

## Using the Library in the Real World

The tutorial and examples use `InMemoryEventStore`, but a production system needs several more pieces: a real persistence adapter, well-reasoned aggregate boundaries, a projection strategy, and a way to connect the command pipeline to your API layer. This section covers each of those.

---

### Implementing an EventStore adapter

The only thing standing between this library and a real database is two methods: `load` and `append`. Both return `Result` — no exceptions cross the boundary.

Here's a PostgreSQL adapter as a concrete reference. It assumes an `events` table with columns `(stream_id, version, type, payload, idempotency_key)`:

```ts
import {
  type EventStore,
  type AnyEvent,
  type StreamState,
  type PersistedEvent,
  type CoreError,
  Ok,
  Err,
} from "@ts-event-sourcing/core"
import { Pool } from "pg"

export class PostgresEventStore<E extends AnyEvent> implements EventStore<E> {
  constructor(private readonly pool: Pool) {}

  async load(params: {
    streamId: string
    toVersion?: number
  }): Promise<Result<StreamState<E>, CoreError>> {
    try {
      const { rows } = await this.pool.query(
        `SELECT version, type, payload
           FROM events
          WHERE stream_id = $1
            ${params.toVersion != null ? "AND version <= $2" : ""}
          ORDER BY version ASC`,
        params.toVersion != null
          ? [params.streamId, params.toVersion]
          : [params.streamId]
      )

      if (rows.length === 0) {
        return Ok({ type: "EmptyStream", streamId: params.streamId })
      }

      const events: PersistedEvent<E>[] = rows.map(row => ({
        ...JSON.parse(row.payload),
        type: row.type,
        version: row.version,
      }))

      return Ok({
        type: "LoadedStream",
        streamId: params.streamId,
        events,
        lastVersion: rows[rows.length - 1].version,
      })
    } catch (err) {
      return Err({ type: "StoreError", cause: err })
    }
  }

  async append(params: {
    streamId: string
    expectedVersion: number
    events: readonly E[]
    idempotencyKey: string
  }): Promise<Result<{ events: readonly PersistedEvent<E>[]; lastVersion: number }, CoreError>> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")

      // Idempotency check — if this key was already committed, return the stored events
      const idempotent = await client.query(
        "SELECT payload, version FROM events WHERE stream_id = $1 AND idempotency_key = $2 ORDER BY version",
        [params.streamId, params.idempotencyKey]
      )
      if (idempotent.rows.length > 0) {
        await client.query("ROLLBACK")
        const stored = idempotent.rows.map(r => ({ ...JSON.parse(r.payload), version: r.version }))
        return Ok({ events: stored, lastVersion: stored[stored.length - 1].version })
      }

      // Optimistic concurrency check
      const { rows: versionCheck } = await client.query(
        "SELECT MAX(version) AS current FROM events WHERE stream_id = $1",
        [params.streamId]
      )
      const currentVersion = versionCheck[0].current ?? 0
      if (currentVersion !== params.expectedVersion) {
        await client.query("ROLLBACK")
        return Err({ type: "ConcurrencyConflict", streamId: params.streamId, expected: params.expectedVersion, actual: currentVersion })
      }

      // Append events
      const persisted: PersistedEvent<E>[] = []
      for (let i = 0; i < params.events.length; i++) {
        const event = params.events[i]
        const version = params.expectedVersion + i + 1
        await client.query(
          "INSERT INTO events (stream_id, version, type, payload, idempotency_key) VALUES ($1, $2, $3, $4, $5)",
          [params.streamId, version, event.type, JSON.stringify(event), params.idempotencyKey]
        )
        persisted.push({ ...event, version })
      }

      await client.query("COMMIT")
      return Ok({ events: persisted, lastVersion: persisted[persisted.length - 1]?.version ?? params.expectedVersion })
    } catch (err) {
      await client.query("ROLLBACK")
      return Err({ type: "StoreError", cause: err })
    } finally {
      client.release()
    }
  }
}
```

A few things worth noting in this implementation:

- **Idempotency is checked first** — before the concurrency check, so a retried request with the same key returns the previously committed events without error.
- **Optimistic concurrency is enforced in the same transaction** — reading the current version and inserting new events happen atomically, so two concurrent appends cannot both succeed at the same version.
- **All errors are `Err(CoreError)`** — no exceptions escape the adapter boundary. Callers handle `ConcurrencyConflict` and `StoreError` through the normal `Result` path.

The required schema:

```sql
CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  stream_id       TEXT        NOT NULL,
  version         INTEGER     NOT NULL,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  idempotency_key TEXT        NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (stream_id, version),
  UNIQUE (stream_id, idempotency_key)
);

CREATE INDEX idx_events_stream_id ON events (stream_id, version);
```

---

### Modeling aggregate boundaries

Choosing what belongs inside an aggregate — and where one aggregate ends and another begins — is one of the most consequential design decisions in an event-sourced system. The core rule is: **an aggregate is the unit of transactional consistency**. Everything inside one aggregate changes together, atomically, in a single append. Anything that can change independently should be a separate aggregate.

**One entity, one stream.** A patient is one stream, an order is one stream, a cart is one stream. Use a typed stream ID convention to make this explicit:

```ts
// Derive stream IDs from domain identifiers — never share streams between entity types
const patientStreamId = (patientId: string) => `patient-${patientId}`
const orderStreamId   = (orderId: string)   => `order-${orderId}`
const cartStreamId    = (cartId: string)    => `cart-${cartId}`
```

**Keep aggregates small and focused.** An aggregate should contain only the state needed to enforce its own invariants. If a field is only ever read (never used in a command handler guard), it probably belongs in a projection, not the aggregate state.

```ts
// ❌ Avoid — aggregate state carrying data only used for display
type OrderState = {
  status: OrderStatus
  items: OrderItem[]
  customerName: string      // only shown in UI — not needed for invariants
  customerEmail: string     // same
  formattedTotal: string    // derived, not needed for decisions
}

// ✅ Prefer — lean aggregate state, only what command handlers need
type OrderState = {
  orderId: string
  status: OrderStatus
  items: OrderItem[]        // needed to validate item-level commands
  transactionId?: string    // needed to prevent double-confirmation
}
// customerName, email, formattedTotal → belong in a projection
```

**Don't aggregate across entity boundaries.** If you find a command handler loading data from two different streams to make a decision, that's a signal to reconsider the boundary. Cross-aggregate decisions should be handled by a saga or process manager (out of scope for this library's core) or by denormalising the needed data into the command payload at the API layer.

---

### Modeling projections in a real application

Projections give you queryable read models without burdening the aggregate with display concerns. In practice, you have two strategies for keeping them up to date.

**On-demand projection (simplest):** Rebuild the projection from the stream every time it's queried. Correct by construction, but adds latency proportional to stream length. Best for low-traffic queries or streams that are short-lived.

```ts
// In a query handler / repository
async function getPatientSummary(patientId: string) {
  const result = await project({
    store,
    streamId: patientStreamId(patientId),
    projection: patientSummaryProjection,
  })
  if (!result.ok) throw new Error(`Could not load patient summary: ${result.error.type}`)
  return result.value.state
}
```

**Materialised projection (for performance):** After every successful command, project and persist the read model to a separate table or cache. Trade freshness complexity for query speed.

```ts
// After a successful command execution, rebuild and persist the projection
async function executeAndProject(params: ExecuteParams) {
  const commandResult = await addItem.execute(params)
  if (!commandResult.ok) return commandResult

  const projectionResult = await project({
    store,
    streamId: params.streamId,
    projection: patientSummaryProjection,
  })

  if (projectionResult.ok) {
    await db.upsert("patient_summaries", {
      patient_id: params.streamId,
      ...projectionResult.value.state,
    })
  }

  return commandResult
}
```

Because projections are deterministic folds over events, they can be **rebuilt from scratch at any time** — drop the table, replay all streams, and you recover the full read model. This is one of the most operationally valuable properties of event sourcing.

Keep projection state shapes flat and query-friendly. A `PatientSummary` projection should look like a database row you'd want to `SELECT` directly — not a nested object mirroring the aggregate's internal state.

---

### Wiring it into an HTTP API

In a real application, the command pipeline connects to an HTTP handler at the edges. The handler is responsible for: parsing the request, generating the idempotency key, calling the command, and mapping the result to an HTTP response. All domain logic stays in the command handler.

```ts
import { Router } from "express"
import { PostgresEventStore } from "./store/postgres-event-store"
import { addItem, checkout } from "./domain/cart/commands"
import { cartStreamId } from "./domain/cart/stream"

const router = Router()
const store = new PostgresEventStore(pool)

router.post("/carts/:cartId/items", async (req, res) => {
  const { cartId } = req.params
  const { itemId, quantity } = req.body

  // Accept the idempotency key from the client so retried requests are safe
  const idempotencyKey = req.headers["idempotency-key"] as string ?? crypto.randomUUID()

  const result = await addItem.execute({
    store,
    streamId: cartStreamId(cartId),
    command: { itemId, quantity },
    idempotencyKey,
  })

  if (!result.ok) {
    // Separate domain errors from technical errors by checking the type discriminant
    if ("type" in result.error) {
      switch (result.error.type) {
        case "AlreadyCheckedOut":   return res.status(409).json({ error: "Cart is already checked out" })
        case "InvalidQuantity":     return res.status(400).json({ error: "Quantity must be greater than zero" })
        case "ConcurrencyConflict": return res.status(409).json({ error: "Concurrent modification — please retry" })
        default:                    return res.status(500).json({ error: "Internal error" })
      }
    }
    return res.status(500).json({ error: "Internal error" })
  }

  return res.status(200).json({ state: result.value.state })
})
```

A few structural rules that make this layer clean:

- **Generate idempotency keys at the HTTP boundary**, not deep in the domain. Accepting them from the client (via a header) lets callers safely retry failed requests.
- **Map domain errors to HTTP status codes here**, not in the command handler. The handler returns typed errors; the HTTP layer decides what they mean to a client.
- **Don't put domain logic in route handlers.** If the handler starts checking `state.checkedOut` itself, the logic has leaked out of the domain.

---

### Testing strategy

Because all domain logic lives in pure functions, the library is designed to be tested at three distinct levels — each with different scope and cost.

**Unit testing command handlers** — the cheapest and most precise. Pass state and a command directly; assert on the returned events or error. No store, no async, no setup:

```ts
import { describe, it, expect } from "vitest"
import { addItemHandler } from "./cart/handlers"

describe("addItemHandler", () => {
  it("rejects commands when the cart is already checked out", () => {
    const state = { cartId: "c1", items: {}, checkedOut: true }
    const result = addItemHandler({ state, command: { itemId: "apple", quantity: 1 } })

    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ type: "AlreadyCheckedOut" })
  })

  it("emits ItemAdded on a valid command", () => {
    const state = { cartId: "c1", items: {}, checkedOut: false }
    const result = addItemHandler({ state, command: { itemId: "apple", quantity: 2 } })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual([{ type: "ItemAdded", itemId: "apple", quantity: 2 }])
  })
})
```

**Integration testing with `InMemoryEventStore`** — tests the full `createAggregate` → `execute` → state pipeline without a real database. Use this for scenarios that span multiple commands, or to verify that the aggregate lifecycle behaves correctly:

```ts
import { InMemoryEventStore, createAggregate, unwrap } from "@ts-event-sourcing/core"
import { addItem, checkout } from "./cart/commands"
import { cartStreamId } from "./cart/stream"

describe("cart aggregate", () => {
  it("prevents adding items to a checked-out cart", async () => {
    const store = new InMemoryEventStore()
    const streamId = cartStreamId("test-cart")

    await createAggregate({ store, streamId, events: [], idempotencyKey: "open" })
    unwrap(await addItem.execute({ store, streamId, command: { itemId: "apple", quantity: 1 }, idempotencyKey: "add-1" }))
    unwrap(await checkout.execute({ store, streamId, command: {}, idempotencyKey: "checkout" }))

    const late = await addItem.execute({ store, streamId, command: { itemId: "banana", quantity: 1 }, idempotencyKey: "add-late" })

    expect(late.ok).toBe(false)
    expect(late.error).toEqual({ type: "AlreadyCheckedOut" })
  })
})
```

**End-to-end testing against a real store** — reserved for verifying infrastructure behaviour: concurrency conflicts, idempotency across process restarts, version ordering. Use a dedicated test database and tear it down between runs. These tests are slower and fewer — they validate the adapter, not the domain.

The overall principle: **keep the test pyramid steep**. Most of your tests should be unit tests on pure handlers, with a smaller layer of integration tests, and only a handful of end-to-end tests for the infrastructure boundary.

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