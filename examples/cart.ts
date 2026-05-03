import {
	AggregateDefinition,
	CommandHandler,
	createAggregate,
	defineCommand,
	Err,
	InMemoryEventStore,
	matchEvent,
	Ok,
} from "../src";

type CartEvent =
	| { type: "ItemAdded"; itemId: string; quantity: number }
	| { type: "ItemRemoved"; itemId: string }
	| { type: "CheckedOut" };

type CartState = {
	items: Record<string, number>; // itemId → quantity
	checkedOut: boolean;
};

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

type CartError =
	| "ALREADY_CHECKED_OUT"
	| "INVALID_QUANTITY"
	| "ITEM_NOT_IN_CART";

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
const checkout = defineCommand({
	aggregate: cartAggregate,
	handler: checkoutHandler,
});

const store = new InMemoryEventStore<CartEvent>();

// createAggregate opens the stream — this is a required first step.
// Calling executeCommand on a non-existent stream returns StreamNotFound.
await createAggregate({
	store,
	streamId: "cart-user-1",
	events: [],
	idempotencyKey: "create-cart-user-1",
});

await addItem.execute({
	store,
	streamId: "cart-user-1",
	command: { itemId: "apple", quantity: 2 },
	idempotencyKey: "add-apple-1",
});

await addItem.execute({
	store,
	streamId: "cart-user-1",
	command: { itemId: "banana", quantity: 1 },
	idempotencyKey: "add-banana-1",
});

const result = await checkout.execute({
	store,
	streamId: "cart-user-1",
	command: {},
	idempotencyKey: "checkout-cart-user-1",
});

if (result.ok) {
	console.log(result.value.state);
	// { items: { apple: 2, banana: 1 }, checkedOut: true }
	console.log(result.value.events);
	// [{ type: "CheckedOut" }]
}

// Domain rejection — handler returns Err, no events are appended
const late = await addItem.execute({
	store,
	streamId: "cart-user-1",
	command: { itemId: "cherry", quantity: 1 },
	idempotencyKey: "add-cherry-late",
});

console.log(late); // { ok: false, error: "ALREADY_CHECKED_OUT" }
