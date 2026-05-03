import { describe, expect, it, vi } from "vitest";
import { match } from "./match";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

type OrderStatus =
	| "Pending"
	| "Confirmed"
	| "Shipped"
	| "Delivered"
	| "Cancelled";
interface Order {
	orderId: string;
	status: OrderStatus;
	total: number;
}

const order = (status: OrderStatus, overrides: Partial<Order> = {}): Order => ({
	orderId: "ord-1",
	status,
	total: 100,
	...overrides,
});

// Discriminated union fixture — verifies Extract path in NarrowByKey
type Shape =
	| { kind: "circle"; radius: number }
	| { kind: "rect"; width: number; height: number }
	| { kind: "triangle"; base: number; height: number };

const circle = { kind: "circle", radius: 5 } as Shape;
const rect = { kind: "rect", width: 4, height: 6 } as Shape;
const triangle = { kind: "triangle", base: 3, height: 8 } as Shape;

// ---------------------------------------------------------------------------
// 1. Basic routing
// ---------------------------------------------------------------------------

describe("basic routing", () => {
	it("calls the matching case handler", () => {
		const result = match(order("Pending"), "status", {
			Pending: () => "pending-result",
			Confirmed: () => "confirmed-result",
			Shipped: () => "shipped-result",
			Delivered: () => "delivered-result",
			Cancelled: () => "cancelled-result",
		});
		expect(result).toBe("pending-result");
	});

	it("calls the correct handler for every variant", () => {
		const statuses: OrderStatus[] = [
			"Pending",
			"Confirmed",
			"Shipped",
			"Delivered",
			"Cancelled",
		];

		for (const status of statuses) {
			const result = match(order(status), "status", {
				Pending: () => "Pending",
				Confirmed: () => "Confirmed",
				Shipped: () => "Shipped",
				Delivered: () => "Delivered",
				Cancelled: () => "Cancelled",
			});
			expect(result).toBe(status);
		}
	});

	it("does NOT call handlers for non-matching cases", () => {
		const spy = vi.fn(() => "should-not-run");

		match(order("Pending"), "status", {
			Pending: () => "ok",
			Confirmed: spy,
			Shipped: spy,
			Delivered: spy,
			Cancelled: spy,
		});

		expect(spy).not.toHaveBeenCalled();
	});

	it("calls the handler exactly once", () => {
		const spy = vi.fn(() => 42);

		match(order("Shipped"), "status", {
			Pending: () => 0,
			Confirmed: () => 1,
			Shipped: spy,
			Delivered: () => 3,
			Cancelled: () => 4,
		});

		expect(spy).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// 2. Handler receives the correct object
// ---------------------------------------------------------------------------

describe("handler argument", () => {
	it("passes the full object to the matched handler", () => {
		const input = order("Confirmed", { orderId: "ord-99", total: 250 });

		match(input, "status", {
			Pending: () => null,
			Confirmed: (o) => {
				expect(o).toBe(input); // same reference
				expect(o.orderId).toBe("ord-99");
				expect(o.total).toBe(250);
				return null;
			},
			Shipped: () => null,
			Delivered: () => null,
			Cancelled: () => null,
		});
	});

	it("narrows status to the literal type in the handler (plain interface)", () => {
		// If TypeScript narrows correctly, o.status is literally "Shipped"
		match(order("Shipped"), "status", {
			Pending: () => {},
			Confirmed: () => {},
			Shipped: (o) => {
				const status: "Shipped" = o.status; // compile-time proof
				expect(status).toBe("Shipped");
			},
			Delivered: () => {},
			Cancelled: () => {},
		});
	});

	it("narrows correctly for discriminated unions (Extract path)", () => {
		const area = match(circle as Shape, "kind", {
			circle: (s) => {
				const r: number = s.radius; // compile-time: only circle has radius
				return Math.PI * r * r;
			},
			rect: (s) => s.width * s.height,
			triangle: (s) => 0.5 * s.base * s.height,
		});
		expect(area).toBeCloseTo(Math.PI * 25);
	});
});

// ---------------------------------------------------------------------------
// 3. Return values
// ---------------------------------------------------------------------------

describe("return values", () => {
	it("returns whatever the handler returns (primitive)", () => {
		expect(
			match(order("Delivered"), "status", {
				Pending: () => 1,
				Confirmed: () => 2,
				Shipped: () => 3,
				Delivered: () => 99,
				Cancelled: () => 5,
			}),
		).toBe(99);
	});

	it("returns whatever the handler returns (object)", () => {
		const payload = { ok: true, data: [1, 2, 3] };
		const result = match(order("Cancelled"), "status", {
			Pending: () => null,
			Confirmed: () => null,
			Shipped: () => null,
			Delivered: () => null,
			Cancelled: () => payload,
		});
		expect(result).toBe(payload);
	});

	it("supports undefined as a valid return value", () => {
		const result = match(order("Pending"), "status", {
			Pending: () => undefined,
			Confirmed: () => undefined,
			Shipped: () => undefined,
			Delivered: () => undefined,
			Cancelled: () => undefined,
		});
		expect(result).toBeUndefined();
	});

	it("returns values computed from the narrowed object", () => {
		const area = match(rect as Shape, "kind", {
			circle: (s) => Math.PI * s.radius ** 2,
			rect: (s) => s.width * s.height,
			triangle: (s) => 0.5 * s.base * s.height,
		});
		expect(area).toBe(24); // 4 * 6
	});
});

// ---------------------------------------------------------------------------
// 4. Default / fallback case  (`_`)
// ---------------------------------------------------------------------------

describe("default case (_)", () => {
	it("calls _ when no specific case matches", () => {
		const result = match(order("Shipped"), "status", {
			Pending: () => "pending",
			_: () => "default",
		});
		expect(result).toBe("default");
	});

	it("prefers specific case over _ when both match", () => {
		const result = match(order("Pending"), "status", {
			Pending: () => "specific",
			_: () => "default",
		});
		expect(result).toBe("specific");
	});

	it("_ receives the full object", () => {
		const input = order("Delivered", { orderId: "ord-42" });
		match(input, "status", {
			Pending: () => null,
			_: (o) => {
				expect(o).toBe(input);
				expect(o.orderId).toBe("ord-42");
				return null;
			},
		});
	});

	it("_ alone handles every variant", () => {
		const statuses: OrderStatus[] = [
			"Pending",
			"Confirmed",
			"Shipped",
			"Delivered",
			"Cancelled",
		];

		for (const status of statuses) {
			const result = match(order(status), "status", {
				_: () => "caught",
			});
			expect(result).toBe("caught");
		}
	});

	it("does not call _ when a specific case is matched", () => {
		const defaultSpy = vi.fn(() => "default");

		match(order("Confirmed"), "status", {
			Confirmed: () => "specific",
			_: defaultSpy,
		});

		expect(defaultSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 5. Error handling — missing case without `_`
// ---------------------------------------------------------------------------

describe("missing case without default", () => {
	it("throws when no case matches and there is no _", () => {
		// Force a runtime miss by casting — simulates a value outside the type
		const rogue = { status: "Unknown" as OrderStatus, orderId: "x", total: 0 };

		expect(() =>
			match(rogue, "status", {
				Pending: () => 1,
				Confirmed: () => 2,
				Shipped: () => 3,
				Delivered: () => 4,
				Cancelled: () => 5,
			}),
		).toThrowError(/\[match\]/);
	});

	it("error message includes the unmatched discriminant value", () => {
		const rogue = { status: "Ghost" as OrderStatus, orderId: "x", total: 0 };

		expect(() =>
			match(rogue, "status", {
				Pending: () => 1,
				Confirmed: () => 2,
				Shipped: () => 3,
				Delivered: () => 4,
				Cancelled: () => 5,
			}),
		).toThrowError("Ghost");
	});

	it("error message includes the key name", () => {
		const rogue = { status: "Ghost" as OrderStatus, orderId: "x", total: 0 };

		expect(() =>
			match(rogue, "status", {
				Pending: () => 1,
				Confirmed: () => 2,
				Shipped: () => 3,
				Delivered: () => 4,
				Cancelled: () => 5,
			}),
		).toThrowError("status");
	});
});

// ---------------------------------------------------------------------------
// 6. Works with different key names
// ---------------------------------------------------------------------------

describe("arbitrary discriminant keys", () => {
	it("matches on a key named 'kind'", () => {
		const result = match(triangle as Shape, "kind", {
			circle: () => "circle",
			rect: () => "rect",
			triangle: () => "triangle",
		});
		expect(result).toBe("triangle");
	});

	it("matches on a key named 'type'", () => {
		type Event =
			| { type: "click"; x: number; y: number }
			| { type: "keydown"; key: string }
			| { type: "resize"; width: number };

		const ev: Event = { type: "keydown", key: "Enter" };

		const result = match(ev as Event, "type", {
			click: () => "mouse",
			keydown: (e) => `key:${e.key}`,
			resize: () => "window",
		});
		expect(result).toBe("key:Enter");
	});
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("works with a single-variant union", () => {
		interface Singleton {
			state: "only";
			value: number;
		}
		const obj: Singleton = { state: "only", value: 7 };

		const result = match(obj, "state", {
			only: (o) => o.value * 2,
		});
		expect(result).toBe(14);
	});

	it("handler can throw and the error propagates", () => {
		expect(() =>
			match(order("Pending"), "status", {
				Pending: () => {
					throw new Error("handler-error");
				},
				Confirmed: () => {},
				Shipped: () => {},
				Delivered: () => {},
				Cancelled: () => {},
			}),
		).toThrowError("handler-error");
	});

	it("handler can return a promise", async () => {
		const result = await match(order("Confirmed"), "status", {
			Pending: async () => "pending",
			Confirmed: async () => "confirmed",
			Shipped: async () => "shipped",
			Delivered: async () => "delivered",
			Cancelled: async () => "cancelled",
		});
		expect(result).toBe("confirmed");
	});
});

// ---------------------------------------------------------------------------
// 8. Return type inference with mixed Ok/Err across specific cases + default
// ---------------------------------------------------------------------------

// Minimal Result helpers
type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
const Ok = <T>(v: T): Ok<T> => ({ ok: true, value: v });
const Err = <E>(e: E): Err<E> => ({ ok: false, error: e });

describe("return type inference with default (_)", () => {
	// Known limitation: when _ is present, TypeScript cannot resolve RCases and
	// RDefault independently from the call site, so the return type is `unknown`.
	// To get a typed result, either cast the return value or avoid _ and use an
	// exhaustive match instead.

	it("runtime: specific case is returned when matched (result cast to known type)", () => {
		const result = match(order("Pending"), "status", {
			Pending: (s) => Ok({ orderId: s.orderId }),
			_: () => Err({ type: "InvalidStatus" as const }),
		}) as Ok<{ orderId: string }> | Err<{ type: "InvalidStatus" }>;

		expect(result).toEqual({ ok: true, value: { orderId: "ord-1" } });
	});

	it("runtime: _ is returned for unhandled variants (result cast to known type)", () => {
		const result = match(order("Shipped"), "status", {
			Pending: (s) => Ok({ orderId: s.orderId }),
			_: () => Err({ type: "InvalidStatus" as const }),
		}) as Ok<{ orderId: string }> | Err<{ type: "InvalidStatus" }>;

		expect(result).toEqual({ ok: false, error: { type: "InvalidStatus" } });
	});

	it("runtime: _ alone routes every variant correctly", () => {
		const statuses: OrderStatus[] = [
			"Pending",
			"Confirmed",
			"Shipped",
			"Delivered",
			"Cancelled",
		];
		for (const status of statuses) {
			const result = match(order(status), "status", { _: () => "default" });
			expect(result).toBe("default");
		}
	});
});
