import {
	type AggregateDefinition,
	type CommandHandler,
	createAggregate,
	defineCommand,
	Err,
	InMemoryEventStore,
	loadAggregate,
	match,
	matchEvent,
	Ok,
	type Projection,
	project,
	type Result,
} from "../src/";

// ---------- 1. Domain Events ----------
type OrderEvent =
	| {
			type: "OrderPlaced";
			orderId: string;
			customerId: string;
			items: Array<{ sku: string; quantity: number }>;
	  }
	| { type: "PaymentConfirmed"; orderId: string; transactionId: string }
	| { type: "OrderShipped"; orderId: string; trackingNumber: string }
	| { type: "OrderDelivered"; orderId: string; deliveredAt: Date }
	| { type: "OrderCancelled"; orderId: string; reason: string };

// ---------- 2. Aggregate State ----------
type OrderStatus =
	| "Pending"
	| "Confirmed"
	| "Shipped"
	| "Delivered"
	| "Cancelled";

type OrderState = {
	orderId: string;
	customerId: string;
	items: Array<{ sku: string; quantity: number }>;
	status: OrderStatus;
	transactionId?: string;
	trackingNumber?: string;
	reason?: string;
};

// ---------- 3. Commands ----------
type PlaceOrderCommand = {
	orderId: string;
	customerId: string;
	items: Array<{ sku: string; quantity: number }>;
};

type ConfirmPaymentCommand = {
	transactionId: string;
};

type ShipOrderCommand = {
	trackingNumber: string;
};

type DeliverOrderCommand = {};

type CancelOrderCommand = {
	reason: string;
};

// Domain errors
type OrderError =
	| { type: "OrderAlreadyConfirmed" }
	| { type: "OrderAlreadyShipped" }
	| { type: "OrderAlreadyDelivered" }
	| { type: "OrderAlreadyCancelled" }
	| { type: "CannotShipWithoutPayment" }
	| { type: "CannotCancelAfterShipped" }
	| { type: "OrderNotFound" };

// ---------- 4. Aggregate Reducer (exhaustive) ----------
const orderAggregate: AggregateDefinition<OrderState, OrderEvent> = {
	initialState: {
		orderId: "",
		customerId: "",
		items: [],
		status: "Pending",
	},
	reduce: (state, event) =>
		matchEvent(event, {
			OrderPlaced: (e) => ({
				orderId: e.orderId,
				customerId: e.customerId,
				items: e.items,
				status: "Pending" as OrderStatus,
			}),
			PaymentConfirmed: (e) => ({
				...state,
				status: "Confirmed",
				transactionId: e.transactionId,
			}),
			OrderShipped: (e) => ({
				...state,
				status: "Shipped",
				trackingNumber: e.trackingNumber,
			}),
			OrderDelivered: (e) => ({
				...state,
				status: "Delivered",
				deliveredAt: e.deliveredAt,
			}),
			OrderCancelled: (e) => ({
				...state,
				status: "Cancelled",
				reason: e.reason,
			}),
		}),
};

// ---------- 5. Command Handlers ----------
const placeOrderHandler: CommandHandler<
	OrderState,
	PlaceOrderCommand,
	OrderEvent,
	never
> = ({ command }) => {
	console.log(
		`   → Handler: Placing order ${command.orderId} for customer ${command.customerId}`,
	);
	return Ok([{ type: "OrderPlaced", ...command }]);
};

const confirmPaymentHandler: CommandHandler<
	OrderState,
	ConfirmPaymentCommand,
	OrderEvent,
	OrderError
> = ({ state, command }) => {
	console.log(`   → Handler: Confirming payment for order ${state.orderId}`);
	return match(state, "status", {
		Pending: (state) =>
			Ok([
				{
					type: "PaymentConfirmed",
					orderId: state.orderId,
					transactionId: command.transactionId,
				},
			]),
		Confirmed: () => Err({ type: "OrderAlreadyConfirmed" }),
		Shipped: () => Err({ type: "OrderAlreadyShipped" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});
};

const shipOrderHandler: CommandHandler<
	OrderState,
	ShipOrderCommand,
	OrderEvent,
	OrderError
> = ({ state, command }) => {
	console.log(`   → Handler: Shipping order ${state.orderId}`);

	return match(state, "status", {
		Confirmed: () =>
			Ok([
				{
					type: "OrderShipped",
					orderId: state.orderId,
					trackingNumber: command.trackingNumber,
				},
			]),
		Pending: () => Err({ type: "CannotShipWithoutPayment" }),
		Shipped: () => Err({ type: "OrderAlreadyShipped" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});
};

const deliverOrderHandler: CommandHandler<
	OrderState,
	DeliverOrderCommand,
	OrderEvent,
	OrderError
> = ({ state }) => {
	console.log(`   → Handler: Delivering order ${state.orderId}`);

	return match(state, "status", {
		Shipped: () =>
			Ok([
				{
					type: "OrderDelivered",
					orderId: state.orderId,
					deliveredAt: new Date(),
				},
			]),
		Pending: () => Err({ type: "CannotShipWithoutPayment" }),
		Confirmed: () => Err({ type: "CannotShipWithoutPayment" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});
};

const cancelOrderHandler: CommandHandler<
	OrderState,
	CancelOrderCommand,
	OrderEvent,
	OrderError
> = ({ state, command }) => {
	console.log(
		`   → Handler: Cancelling order ${state.orderId}, reason: ${command.reason}`,
	);

	return match(state, "status", {
		Pending: () =>
			Ok([
				{
					type: "OrderCancelled",
					orderId: state.orderId,
					reason: command.reason,
				},
			]),
		Confirmed: () =>
			Ok([
				{
					type: "OrderCancelled",
					orderId: state.orderId,
					reason: command.reason,
				},
			]),
		Shipped: () => Err({ type: "CannotCancelAfterShipped" }),
		Delivered: () => Err({ type: "CannotCancelAfterShipped" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});
};

// ---------- 6. Wrap commands with defineCommand ----------
const placeOrderCommand = defineCommand({
	aggregate: orderAggregate,
	handler: placeOrderHandler,
});
const confirmPaymentCommand = defineCommand({
	aggregate: orderAggregate,
	handler: confirmPaymentHandler,
});
const shipOrderCommand = defineCommand({
	aggregate: orderAggregate,
	handler: shipOrderHandler,
});
const deliverOrderCommand = defineCommand({
	aggregate: orderAggregate,
	handler: deliverOrderHandler,
});
const cancelOrderCommand = defineCommand({
	aggregate: orderAggregate,
	handler: cancelOrderHandler,
});

// ---------- 7. Projection: count of orders per status ----------
type OrderStats = {
	pending: number;
	confirmed: number;
	shipped: number;
	delivered: number;
	cancelled: number;
};

const statsProjection: Projection<OrderStats, OrderEvent> = {
	initialState: {
		pending: 0,
		confirmed: 0,
		shipped: 0,
		delivered: 0,
		cancelled: 0,
	},
	fold: (stats, event) =>
		matchEvent(event, {
			OrderPlaced: () => ({ ...stats, pending: stats.pending + 1 }),
			PaymentConfirmed: (_e) => {
				// Note: we need to know which order changed from pending to confirmed.
				// For demo, we just decrement pending and increment confirmed.
				// In real projection you'd have a map; this is simplified.
				return {
					...stats,
					pending: stats.pending - 1,
					confirmed: stats.confirmed + 1,
				};
			},
			OrderShipped: () => ({
				...stats,
				confirmed: stats.confirmed - 1,
				shipped: stats.shipped + 1,
			}),
			OrderDelivered: () => ({
				...stats,
				shipped: stats.shipped - 1,
				delivered: stats.delivered + 1,
			}),
			OrderCancelled: () => {
				// Cancellation can happen from Pending or Confirmed (or shipped? prevented by invariants)
				// For simplicity, assume from Pending or Confirmed; adjust stats accordingly.
				// We'll decrement whichever is non-zero (crude but illustrative)
				if (stats.pending > 0)
					return {
						...stats,
						pending: stats.pending - 1,
						cancelled: stats.cancelled + 1,
					};
				if (stats.confirmed > 0)
					return {
						...stats,
						confirmed: stats.confirmed - 1,
						cancelled: stats.cancelled + 1,
					};
				return stats;
			},
		}),
};

// ---------- 8. Helper ----------
function logResult<T, E>(label: string, result: Result<T, E>): T | null {
	if (result.ok) {
		console.log(`✅ ${label}:`, JSON.stringify(result.value, null, 2));
		return result.value;
	} else {
		console.error(`❌ ${label}:`, result.error);
		return null;
	}
}

// ---------- 9. Main ----------
async function main() {
	console.log("\n=== Order Management with Event Sourcing ===\n");

	const store = new InMemoryEventStore<OrderEvent>();
	const orderId = "order-456";

	// 1. Create aggregate stream
	console.log("1. Creating order stream...");
	await createAggregate({
		store,
		streamId: orderId,
		events: [],
		idempotencyKey: "create-order",
	});
	console.log();

	// 2. Place order
	console.log("2. Placing order...");
	const placeResult = await placeOrderCommand.execute({
		store,
		streamId: orderId,
		command: {
			orderId,
			customerId: "customer-789",
			items: [
				{ sku: "SKU-100", quantity: 2 },
				{ sku: "SKU-200", quantity: 1 },
			],
		},
		idempotencyKey: "place-order",
	});
	const placed = logResult("Place order", placeResult);
	if (!placed) return;
	console.log();

	// 3. Try to ship before payment (should fail)
	console.log("3. Attempting to ship before payment (should error)...");
	const shipEarly = await shipOrderCommand.execute({
		store,
		streamId: orderId,
		command: { trackingNumber: "TRACK-123" },
		idempotencyKey: "ship-early",
	});
	logResult("Ship before payment", shipEarly);
	console.log();

	// 4. Confirm payment
	console.log("4. Confirming payment...");
	const confirmResult = await confirmPaymentCommand.execute({
		store,
		streamId: orderId,
		command: { transactionId: "txn-abcde" },
		idempotencyKey: "confirm-payment",
	});
	logResult("Confirm payment", confirmResult);
	console.log();

	// 5. Ship order
	console.log("5. Shipping order...");
	const shipResult = await shipOrderCommand.execute({
		store,
		streamId: orderId,
		command: { trackingNumber: "TRACK-123" },
		idempotencyKey: "ship-order",
	});
	logResult("Ship order", shipResult);
	console.log();

	// 6. Deliver order
	console.log("6. Delivering order...");
	const deliverResult = await deliverOrderCommand.execute({
		store,
		streamId: orderId,
		command: {},
		idempotencyKey: "deliver-order",
	});
	logResult("Deliver order", deliverResult);
	console.log();

	// 7. Try to cancel after delivery (should fail)
	console.log("7. Attempting to cancel after delivery (should error)...");
	const cancelLate = await cancelOrderCommand.execute({
		store,
		streamId: orderId,
		command: { reason: "Changed mind" },
		idempotencyKey: "cancel-late",
	});
	logResult("Cancel after delivery", cancelLate);
	console.log();

	// 8. Project stats (read model)
	console.log("8. Projecting order statistics...");
	const statsResult = await project({
		store,
		streamId: orderId,
		projection: statsProjection,
	});
	const stats = logResult("Order stats", statsResult);
	if (stats) {
		console.log("   → Current order status distribution:", stats.state);
	}
	console.log();

	// 9. Load final aggregate state
	console.log("9. Loading final aggregate state...");
	const loadResult = await loadAggregate({
		store,
		streamId: orderId,
		aggregate: orderAggregate,
	});
	const loaded = logResult("Final order state", loadResult);
	if (loaded) {
		console.log(`   → Order ${loaded.state.orderId} is ${loaded.state.status}`);
	}

	console.log("\n=== Example completed ===");
}

main().catch(console.error);
