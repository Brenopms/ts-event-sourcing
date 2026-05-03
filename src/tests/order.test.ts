import { describe, expect, it } from "vitest";
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
	unwrap,
} from "../";

// ─── Domain ────────────────────────────────────────────────────────────────

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
};

type OrderError =
	| { type: "OrderAlreadyConfirmed" }
	| { type: "OrderAlreadyShipped" }
	| { type: "OrderAlreadyDelivered" }
	| { type: "OrderAlreadyCancelled" }
	| { type: "CannotShipWithoutPayment" }
	| { type: "CannotCancelAfterShipped" };

const orderAggregate: AggregateDefinition<OrderState, OrderEvent> = {
	initialState: { orderId: "", customerId: "", items: [], status: "Pending" },
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

const placeOrderHandler: CommandHandler<
	OrderState,
	{
		orderId: string;
		customerId: string;
		items: Array<{ sku: string; quantity: number }>;
	},
	OrderEvent,
	never
> = ({ command }) => Ok([{ type: "OrderPlaced", ...command }]);

const confirmPaymentHandler: CommandHandler<
	OrderState,
	{ transactionId: string },
	OrderEvent,
	OrderError
> = ({ state, command }) =>
	match(state, "status", {
		Pending: (s) =>
			Ok([
				{
					type: "PaymentConfirmed",
					orderId: s.orderId,
					transactionId: command.transactionId,
				},
			]),
		Confirmed: () => Err({ type: "OrderAlreadyConfirmed" }),
		Shipped: () => Err({ type: "OrderAlreadyShipped" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});

const shipOrderHandler: CommandHandler<
	OrderState,
	{ trackingNumber: string },
	OrderEvent,
	OrderError
> = ({ state, command }) =>
	match(state, "status", {
		Confirmed: (s) =>
			Ok([
				{
					type: "OrderShipped",
					orderId: s.orderId,
					trackingNumber: command.trackingNumber,
				},
			]),
		Pending: () => Err({ type: "CannotShipWithoutPayment" }),
		Shipped: () => Err({ type: "OrderAlreadyShipped" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});

const deliverOrderHandler: CommandHandler<
	OrderState,
	Record<never, never>,
	OrderEvent,
	OrderError
> = ({ state }) =>
	match(state, "status", {
		Shipped: (s) =>
			Ok([
				{ type: "OrderDelivered", orderId: s.orderId, deliveredAt: new Date() },
			]),
		Pending: () => Err({ type: "CannotShipWithoutPayment" }),
		Confirmed: () => Err({ type: "CannotShipWithoutPayment" }),
		Delivered: () => Err({ type: "OrderAlreadyDelivered" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});

const cancelOrderHandler: CommandHandler<
	OrderState,
	{ reason: string },
	OrderEvent,
	OrderError
> = ({ state, command }) =>
	match(state, "status", {
		Pending: (s) =>
			Ok([
				{ type: "OrderCancelled", orderId: s.orderId, reason: command.reason },
			]),
		Confirmed: (s) =>
			Ok([
				{ type: "OrderCancelled", orderId: s.orderId, reason: command.reason },
			]),
		Shipped: () => Err({ type: "CannotCancelAfterShipped" }),
		Delivered: () => Err({ type: "CannotCancelAfterShipped" }),
		Cancelled: () => Err({ type: "OrderAlreadyCancelled" }),
	});

const placeOrder = defineCommand({
	aggregate: orderAggregate,
	handler: placeOrderHandler,
});
const confirmPayment = defineCommand({
	aggregate: orderAggregate,
	handler: confirmPaymentHandler,
});
const shipOrder = defineCommand({
	aggregate: orderAggregate,
	handler: shipOrderHandler,
});
const deliverOrder = defineCommand({
	aggregate: orderAggregate,
	handler: deliverOrderHandler,
});
const cancelOrder = defineCommand({
	aggregate: orderAggregate,
	handler: cancelOrderHandler,
});

// ─── Projection ────────────────────────────────────────────────────────────

type StatusTransition = { status: OrderStatus; at: Date; detail?: string };

type OrderLifecycle = {
	orderId: string;
	customerId: string;
	itemCount: number;
	timeline: StatusTransition[];
	currentStatus: OrderStatus;
};

const orderLifecycleProjection: Projection<OrderLifecycle, OrderEvent> = {
	initialState: {
		orderId: "",
		customerId: "",
		itemCount: 0,
		timeline: [],
		currentStatus: "Pending",
	},
	fold: (state, event) =>
		matchEvent(event, {
			OrderPlaced: (e) => ({
				...state,
				orderId: e.orderId,
				customerId: e.customerId,
				itemCount: e.items.reduce((s, i) => s + i.quantity, 0),
				currentStatus: "Pending",
				timeline: [{ status: "Pending", at: new Date() }],
			}),
			PaymentConfirmed: (e) => ({
				...state,
				currentStatus: "Confirmed",
				timeline: [
					...state.timeline,
					{
						status: "Confirmed",
						at: new Date(),
						detail: `txn: ${e.transactionId}`,
					},
				],
			}),
			OrderShipped: (e) => ({
				...state,
				currentStatus: "Shipped",
				timeline: [
					...state.timeline,
					{
						status: "Shipped",
						at: new Date(),
						detail: `tracking: ${e.trackingNumber}`,
					},
				],
			}),
			OrderDelivered: (e) => ({
				...state,
				currentStatus: "Delivered",
				timeline: [
					...state.timeline,
					{ status: "Delivered", at: e.deliveredAt },
				],
			}),
			OrderCancelled: (e) => ({
				...state,
				currentStatus: "Cancelled",
				timeline: [
					...state.timeline,
					{
						status: "Cancelled",
						at: new Date(),
						detail: `reason: ${e.reason}`,
					},
				],
			}),
		}),
};

// ─── Setup helpers ─────────────────────────────────────────────────────────

const DEFAULT_ITEMS = [
	{ sku: "SKU-100", quantity: 2 },
	{ sku: "SKU-200", quantity: 1 },
];

// Opens a stream and immediately places an order. Returns { store, streamId }.
async function placedOrder(orderId = "order-1") {
	const store = new InMemoryEventStore<OrderEvent>();
	await createAggregate({
		store,
		streamId: orderId,
		events: [],
		idempotencyKey: `open-${orderId}`,
	});
	unwrap(
		await placeOrder.execute({
			store,
			streamId: orderId,
			command: { orderId, customerId: "cust-1", items: DEFAULT_ITEMS },
			idempotencyKey: `place-${orderId}`,
		}),
	);
	return { store, streamId: orderId };
}

async function confirmedOrder(orderId = "order-1") {
	const { store, streamId } = await placedOrder(orderId);
	unwrap(
		await confirmPayment.execute({
			store,
			streamId,
			command: { transactionId: "txn-abc" },
			idempotencyKey: `confirm-${orderId}`,
		}),
	);
	return { store, streamId };
}

async function shippedOrder(orderId = "order-1") {
	const { store, streamId } = await confirmedOrder(orderId);
	unwrap(
		await shipOrder.execute({
			store,
			streamId,
			command: { trackingNumber: "TRACK-001" },
			idempotencyKey: `ship-${orderId}`,
		}),
	);
	return { store, streamId };
}

async function deliveredOrder(orderId = "order-1") {
	const { store, streamId } = await shippedOrder(orderId);
	unwrap(
		await deliverOrder.execute({
			store,
			streamId,
			command: {},
			idempotencyKey: `deliver-${orderId}`,
		}),
	);
	return { store, streamId };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Order — placeOrder", () => {
	it("places an order and sets status to Pending", async () => {
		const store = new InMemoryEventStore<OrderEvent>();
		await createAggregate({
			store,
			streamId: "order-1",
			events: [],
			idempotencyKey: "open",
		});

		const result = await placeOrder.execute({
			store,
			streamId: "order-1",
			command: {
				orderId: "order-1",
				customerId: "cust-1",
				items: DEFAULT_ITEMS,
			},
			idempotencyKey: "place",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Pending");
		expect(result.value.state.customerId).toBe("cust-1");
		expect(result.value.state.items).toEqual(DEFAULT_ITEMS);
		expect(result.value.events[0].type).toBe("OrderPlaced");
	});
});

describe("Order — confirmPayment", () => {
	it("confirms payment on a Pending order", async () => {
		const { store, streamId } = await placedOrder();

		const result = await confirmPayment.execute({
			store,
			streamId,
			command: { transactionId: "txn-abc" },
			idempotencyKey: "confirm",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Confirmed");
		expect(result.value.state.transactionId).toBe("txn-abc");
	});

	it("rejects confirming an already-confirmed order", async () => {
		const { store, streamId } = await confirmedOrder();

		const result = await confirmPayment.execute({
			store,
			streamId,
			command: { transactionId: "txn-xyz" },
			idempotencyKey: "confirm-again",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyConfirmed" });
	});

	it("rejects confirming a shipped order", async () => {
		const { store, streamId } = await shippedOrder();

		const result = await confirmPayment.execute({
			store,
			streamId,
			command: { transactionId: "txn-late" },
			idempotencyKey: "confirm-late",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyShipped" });
	});

	it("rejects confirming a cancelled order", async () => {
		const { store, streamId } = await placedOrder();
		unwrap(
			await cancelOrder.execute({
				store,
				streamId,
				command: { reason: "changed mind" },
				idempotencyKey: "cancel",
			}),
		);

		const result = await confirmPayment.execute({
			store,
			streamId,
			command: { transactionId: "txn-late" },
			idempotencyKey: "confirm-cancelled",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyCancelled" });
	});
});

describe("Order — shipOrder", () => {
	it("ships a confirmed order", async () => {
		const { store, streamId } = await confirmedOrder();

		const result = await shipOrder.execute({
			store,
			streamId,
			command: { trackingNumber: "TRACK-001" },
			idempotencyKey: "ship",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Shipped");
		expect(result.value.state.trackingNumber).toBe("TRACK-001");
	});

	it("rejects shipping a Pending order (payment not confirmed)", async () => {
		const { store, streamId } = await placedOrder();

		const result = await shipOrder.execute({
			store,
			streamId,
			command: { trackingNumber: "TRACK-001" },
			idempotencyKey: "ship-early",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "CannotShipWithoutPayment" });
	});

	it("rejects shipping an already-shipped order", async () => {
		const { store, streamId } = await shippedOrder();

		const result = await shipOrder.execute({
			store,
			streamId,
			command: { trackingNumber: "TRACK-002" },
			idempotencyKey: "ship-again",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyShipped" });
	});

	it("rejects shipping a delivered order", async () => {
		const { store, streamId } = await deliveredOrder();

		const result = await shipOrder.execute({
			store,
			streamId,
			command: { trackingNumber: "TRACK-late" },
			idempotencyKey: "ship-delivered",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyDelivered" });
	});
});

describe("Order — deliverOrder", () => {
	it("delivers a shipped order", async () => {
		const { store, streamId } = await shippedOrder();

		const result = await deliverOrder.execute({
			store,
			streamId,
			command: {},
			idempotencyKey: "deliver",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Delivered");
	});

	it("rejects delivering a Pending order", async () => {
		const { store, streamId } = await placedOrder();

		const result = await deliverOrder.execute({
			store,
			streamId,
			command: {},
			idempotencyKey: "deliver-pending",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "CannotShipWithoutPayment" });
	});

	it("rejects delivering an already-delivered order", async () => {
		const { store, streamId } = await deliveredOrder();

		const result = await deliverOrder.execute({
			store,
			streamId,
			command: {},
			idempotencyKey: "deliver-again",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyDelivered" });
	});
});

describe("Order — cancelOrder", () => {
	it("cancels a Pending order", async () => {
		const { store, streamId } = await placedOrder();

		const result = await cancelOrder.execute({
			store,
			streamId,
			command: { reason: "changed mind" },
			idempotencyKey: "cancel",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Cancelled");
	});

	it("cancels a Confirmed order", async () => {
		const { store, streamId } = await confirmedOrder();

		const result = await cancelOrder.execute({
			store,
			streamId,
			command: { reason: "out of stock" },
			idempotencyKey: "cancel",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.status).toBe("Cancelled");
	});

	it("rejects cancelling a shipped order", async () => {
		const { store, streamId } = await shippedOrder();

		const result = await cancelOrder.execute({
			store,
			streamId,
			command: { reason: "too late" },
			idempotencyKey: "cancel-shipped",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "CannotCancelAfterShipped" });
	});

	it("rejects cancelling a delivered order", async () => {
		const { store, streamId } = await deliveredOrder();

		const result = await cancelOrder.execute({
			store,
			streamId,
			command: { reason: "too late" },
			idempotencyKey: "cancel-delivered",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "CannotCancelAfterShipped" });
	});

	it("rejects cancelling an already-cancelled order", async () => {
		const { store, streamId } = await placedOrder();
		unwrap(
			await cancelOrder.execute({
				store,
				streamId,
				command: { reason: "first cancel" },
				idempotencyKey: "cancel-1",
			}),
		);

		const result = await cancelOrder.execute({
			store,
			streamId,
			command: { reason: "second cancel" },
			idempotencyKey: "cancel-2",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "OrderAlreadyCancelled" });
	});
});

describe("Order — orderLifecycleProjection", () => {
	it("reflects the full Pending → Confirmed → Shipped → Delivered flow", async () => {
		const { store, streamId } = await deliveredOrder();

		const result = await project({
			store,
			streamId,
			projection: orderLifecycleProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const { state } = result.value;
		expect(state.currentStatus).toBe("Delivered");
		expect(state.itemCount).toBe(3); // 2 + 1 from DEFAULT_ITEMS
		expect(state.timeline.map((t) => t.status)).toEqual([
			"Pending",
			"Confirmed",
			"Shipped",
			"Delivered",
		]);
		expect(state.timeline[1].detail).toContain("txn-abc");
		expect(state.timeline[2].detail).toContain("TRACK-001");
	});

	it("reflects a Pending → Cancelled flow", async () => {
		const { store, streamId } = await placedOrder();
		unwrap(
			await cancelOrder.execute({
				store,
				streamId,
				command: { reason: "no longer needed" },
				idempotencyKey: "cancel",
			}),
		);

		const result = await project({
			store,
			streamId,
			projection: orderLifecycleProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const { state } = result.value;
		expect(state.currentStatus).toBe("Cancelled");
		expect(state.timeline.map((t) => t.status)).toEqual([
			"Pending",
			"Cancelled",
		]);
		expect(state.timeline[1].detail).toContain("no longer needed");
	});

	it("records the correct item count from the order", async () => {
		const { store, streamId } = await placedOrder();

		const result = await project({
			store,
			streamId,
			projection: orderLifecycleProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// DEFAULT_ITEMS: SKU-100 qty 2 + SKU-200 qty 1 = 3
		expect(result.value.state.itemCount).toBe(3);
	});
});

describe("Order — aggregate state replay", () => {
	it("rebuilds the correct final state from the full event log", async () => {
		const { store, streamId } = await deliveredOrder();

		const loaded = unwrap(
			await loadAggregate({ store, streamId, aggregate: orderAggregate }),
		);

		expect(loaded.state.status).toBe("Delivered");
		expect(loaded.state.transactionId).toBe("txn-abc");
		expect(loaded.state.trackingNumber).toBe("TRACK-001");
	});
});
