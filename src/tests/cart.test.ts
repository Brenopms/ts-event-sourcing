import { describe, expect, it } from "vitest";
import {
	type AggregateDefinition,
	type CommandHandler,
	createAggregate,
	defineCommand,
	Err,
	InMemoryEventStore,
	loadAggregate,
	matchEvent,
	Ok,
	unwrap,
} from "../";

// ─── Domain ────────────────────────────────────────────────────────────────

type CartEvent =
	| { type: "ItemAdded"; itemId: string; quantity: number }
	| { type: "ItemRemoved"; itemId: string }
	| { type: "CheckedOut" };

type CartState = {
	items: Record<string, number>;
	checkedOut: boolean;
};

type CartError =
	| "ALREADY_CHECKED_OUT"
	| "INVALID_QUANTITY"
	| "ITEM_NOT_IN_CART";

const cartAggregate: AggregateDefinition<CartState, CartEvent> = {
	initialState: { items: {}, checkedOut: false },
	reduce: (state, event) =>
		matchEvent(event, {
			ItemAdded: (e) => ({
				...state,
				items: {
					...state.items,
					[e.itemId]: (state.items[e.itemId] ?? 0) + e.quantity,
				},
			}),
			ItemRemoved: (e) => {
				const { [e.itemId]: _, ...rest } = state.items;
				return { ...state, items: rest };
			},
			CheckedOut: () => ({ ...state, checkedOut: true }),
		}),
};

const addItemHandler: CommandHandler<
	CartState,
	{ itemId: string; quantity: number },
	CartEvent,
	CartError
> = ({ state, command }) => {
	if (state.checkedOut) return Err("ALREADY_CHECKED_OUT");
	if (command.quantity <= 0) return Err("INVALID_QUANTITY");
	return Ok([
		{ type: "ItemAdded", itemId: command.itemId, quantity: command.quantity },
	]);
};

const removeItemHandler: CommandHandler<
	CartState,
	{ itemId: string },
	CartEvent,
	CartError
> = ({ state, command }) => {
	if (state.checkedOut) return Err("ALREADY_CHECKED_OUT");
	if (!(command.itemId in state.items)) return Err("ITEM_NOT_IN_CART");
	return Ok([{ type: "ItemRemoved", itemId: command.itemId }]);
};

const checkoutHandler: CommandHandler<
	CartState,
	Record<never, never>,
	CartEvent,
	CartError
> = ({ state }) => {
	if (state.checkedOut) return Err("ALREADY_CHECKED_OUT");
	return Ok([{ type: "CheckedOut" }]);
};

const addItem = defineCommand({
	aggregate: cartAggregate,
	handler: addItemHandler,
});

const removeItem = defineCommand({
	aggregate: cartAggregate,
	handler: removeItemHandler,
});

const checkout = defineCommand({
	aggregate: cartAggregate,
	handler: checkoutHandler,
});

// ─── Setup helpers ─────────────────────────────────────────────────────────

const STREAM = "cart-1";

// Returns a fresh store with an open, empty cart stream.
async function openCart() {
	const store = new InMemoryEventStore<CartEvent>();
	await createAggregate({
		store,
		streamId: STREAM,
		events: [],
		idempotencyKey: "open",
	});
	return store;
}

// Returns a fresh store with a cart that already has items in it.
async function cartWithItems() {
	const store = await openCart();
	unwrap(
		await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: 2 },
			idempotencyKey: "add-apple",
		}),
	);
	unwrap(
		await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "banana", quantity: 1 },
			idempotencyKey: "add-banana",
		}),
	);
	return store;
}

// Returns a fresh store with a checked-out cart.
async function checkedOutCart() {
	const store = await cartWithItems();
	unwrap(
		await checkout.execute({
			store,
			streamId: STREAM,
			command: {},
			idempotencyKey: "checkout",
		}),
	);
	return store;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Cart — addItem", () => {
	it("adds a single item to an empty cart", async () => {
		const store = await openCart();

		const result = await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: 3 },
			idempotencyKey: "add-apple",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.state.items).toEqual({ apple: 3 });
		expect(result.value.events).toEqual([
			{ type: "ItemAdded", itemId: "apple", quantity: 3 },
		]);
	});

	it("accumulates quantity when the same item is added twice", async () => {
		const store = await openCart();
		unwrap(
			await addItem.execute({
				store,
				streamId: STREAM,
				command: { itemId: "apple", quantity: 2 },
				idempotencyKey: "add-1",
			}),
		);

		const result = await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: 3 },
			idempotencyKey: "add-2",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.items).toEqual({ apple: 5 });
	});

	it("adds multiple distinct items independently", async () => {
		const store = await cartWithItems();

		const result = await loadAggregate({
			store,
			streamId: STREAM,
			aggregate: cartAggregate,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.items).toEqual({ apple: 2, banana: 1 });
	});

	it("rejects a quantity of zero", async () => {
		const store = await openCart();

		const result = await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: 0 },
			idempotencyKey: "add-zero",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("INVALID_QUANTITY");
	});

	it("rejects a negative quantity", async () => {
		const store = await openCart();

		const result = await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: -1 },
			idempotencyKey: "add-negative",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("INVALID_QUANTITY");
	});

	it("rejects adding an item to a checked-out cart", async () => {
		const store = await checkedOutCart();

		const result = await addItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "cherry", quantity: 1 },
			idempotencyKey: "add-late",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("ALREADY_CHECKED_OUT");
	});

	it("is idempotent — replaying the same key does not duplicate items", async () => {
		const store = await openCart();
		const params = {
			store,
			streamId: STREAM,
			command: { itemId: "apple", quantity: 2 },
			idempotencyKey: "add-apple",
		};

		unwrap(await addItem.execute(params));
		// Submit the exact same command again with the same idempotencyKey
		const second = await addItem.execute(params);

		// The store detects the duplicate and does not append again
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect((second.error as { type: string }).type).toBe(
			"IdempotencyViolation",
		);

		// State must still reflect only one addition
		const loaded = unwrap(
			await loadAggregate({
				store,
				streamId: STREAM,
				aggregate: cartAggregate,
			}),
		);
		expect(loaded.state.items).toEqual({ apple: 2 });
	});
});

describe("Cart — removeItem", () => {
	it("removes an existing item from the cart", async () => {
		const store = await cartWithItems();

		const result = await removeItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple" },
			idempotencyKey: "remove-apple",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.items).toEqual({ banana: 1 });
		expect("apple" in result.value.state.items).toBe(false);
	});

	it("rejects removing an item that is not in the cart", async () => {
		const store = await openCart();

		const result = await removeItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "nonexistent" },
			idempotencyKey: "remove-missing",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("ITEM_NOT_IN_CART");
	});

	it("rejects removing an item from a checked-out cart", async () => {
		const store = await checkedOutCart();

		const result = await removeItem.execute({
			store,
			streamId: STREAM,
			command: { itemId: "apple" },
			idempotencyKey: "remove-late",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("ALREADY_CHECKED_OUT");
	});
});

describe("Cart — checkout", () => {
	it("checks out a cart with items", async () => {
		const store = await cartWithItems();

		const result = await checkout.execute({
			store,
			streamId: STREAM,
			command: {},
			idempotencyKey: "checkout",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.checkedOut).toBe(true);
		expect(result.value.state.items).toEqual({ apple: 2, banana: 1 });
		expect(result.value.events).toEqual([{ type: "CheckedOut" }]);
	});

	it("checks out an empty cart", async () => {
		const store = await openCart();

		const result = await checkout.execute({
			store,
			streamId: STREAM,
			command: {},
			idempotencyKey: "checkout",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.checkedOut).toBe(true);
		expect(result.value.state.items).toEqual({});
	});

	it("rejects checking out an already checked-out cart", async () => {
		const store = await checkedOutCart();

		const result = await checkout.execute({
			store,
			streamId: STREAM,
			command: {},
			idempotencyKey: "checkout-again",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("ALREADY_CHECKED_OUT");
	});
});

describe("Cart — state replay", () => {
	it("rebuilds the correct state from a full event sequence", async () => {
		const store = await openCart();
		unwrap(
			await addItem.execute({
				store,
				streamId: STREAM,
				command: { itemId: "apple", quantity: 3 },
				idempotencyKey: "add-apple",
			}),
		);
		unwrap(
			await addItem.execute({
				store,
				streamId: STREAM,
				command: { itemId: "banana", quantity: 2 },
				idempotencyKey: "add-banana",
			}),
		);
		unwrap(
			await removeItem.execute({
				store,
				streamId: STREAM,
				command: { itemId: "apple" },
				idempotencyKey: "remove-apple",
			}),
		);
		unwrap(
			await addItem.execute({
				store,
				streamId: STREAM,
				command: { itemId: "cherry", quantity: 1 },
				idempotencyKey: "add-cherry",
			}),
		);
		unwrap(
			await checkout.execute({
				store,
				streamId: STREAM,
				command: {},
				idempotencyKey: "checkout",
			}),
		);

		const result = await loadAggregate({
			store,
			streamId: STREAM,
			aggregate: cartAggregate,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state).toEqual({
			items: { banana: 2, cherry: 1 },
			checkedOut: true,
		});
	});
});
