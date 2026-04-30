import { describe, expect, it, vi } from "vitest";
import { andThen, andThenSync, mapOk, unwrap } from "./result-combinators";
import { Err, Ok } from "./result-wrappers";

describe("unwrap", () => {
	it("returns the value for an Ok result", () => {
		expect(unwrap(Ok(42))).toBe(42);
	});

	it("works with complex value types", () => {
		const value = { state: { count: 3 }, lastVersion: 5 };
		expect(unwrap(Ok(value))).toEqual(value);
	});

	it("throws the error for an Err result (primitive)", () => {
		expect(() => unwrap(Err("INVALID"))).toThrow("INVALID");
	});

	it("throws the error for an Err result (object)", () => {
		const error = { type: "StoreError", cause: "db down" };
		expect(() => unwrap(Err(error))).toThrow(expect.objectContaining(error));
	});

	it("returns undefined for Ok(undefined)", () => {
		expect(unwrap(Ok(undefined))).toBeUndefined();
	});

	it("returns null for Ok(null)", () => {
		expect(unwrap(Ok(null))).toBeNull();
	});
});

describe("mapOk", () => {
	it("applies the transform to an Ok value", () => {
		const result = mapOk(Ok(3), (n) => n * 2);
		expect(result).toEqual(Ok(6));
	});

	it("passes through an Err result without calling the transform", () => {
		const fn = vi.fn();
		const result = mapOk(Err("StoreError"), fn);

		expect(result).toEqual(Err("StoreError"));
		expect(fn).not.toHaveBeenCalled();
	});

	it("can change the value type", () => {
		const result = mapOk(Ok(42), (n) => n.toString());
		expect(result).toEqual(Ok("42"));
	});

	it("can map to a complex object", () => {
		const result = mapOk(
			Ok({ state: 5, lastVersion: 2 }),
			({ state, lastVersion }) => ({ doubled: state * 2, lastVersion }),
		);
		expect(result).toEqual(Ok({ doubled: 10, lastVersion: 2 }));
	});

	it("preserves the error type unchanged", () => {
		const error = { type: "AggregateNotFound" as const };
		const result = mapOk(Err(error), (n: number) => n + 1);
		expect(result).toEqual(Err(error));
	});

	it("is composable — multiple mapOk calls chain correctly", () => {
		const result = mapOk(
			mapOk(Ok(1), (n) => n + 1),
			(n) => n * 10,
		);
		expect(result).toEqual(Ok(20));
	});
});

describe("andThen", () => {
	it("calls fn with the success value and returns its result", async () => {
		const result = await andThen(Ok("stream-1"), async (id) =>
			Ok({ id, events: [] }),
		);
		expect(result).toEqual(Ok({ id: "stream-1", events: [] }));
	});

	it("short-circuits on Err and does not call fn", async () => {
		const fn = vi.fn();
		const result = await andThen(Err({ type: "StoreError" }), fn);

		expect(result).toEqual(Err({ type: "StoreError" }));
		expect(fn).not.toHaveBeenCalled();
	});

	it("propagates errors returned by fn", async () => {
		const result = await andThen(Ok("stream-1"), async () =>
			Err({ type: "StreamNotFound" as const }),
		);
		expect(result).toEqual(Err({ type: "StreamNotFound" }));
	});

	it("is composable — chaining multiple andThen calls", async () => {
		const step1 = async (n: number) => Ok(n + 1);
		const step2 = async (n: number) => Ok(n * 10);
		const step3 = async (n: number) => Ok(`result: ${n}`);

		const result = await andThen(
			await andThen(await andThen(Ok(1), step1), step2),
			step3,
		);

		expect(result).toEqual(Ok("result: 20"));
	});

	it("stops the chain at the first failure", async () => {
		const step2 = vi.fn();

		const result = await andThen(
			await andThen(Ok(1), async () => Err("FAILED")),
			step2,
		);

		expect(result).toEqual(Err("FAILED"));
		expect(step2).not.toHaveBeenCalled();
	});
});

// ─── andThenSync ─────────────────────────────────────────────────────────────

describe("andThenSync", () => {
	it("calls fn with the success value and returns its result", () => {
		const result = andThenSync(Ok(5), (n) => Ok(n * 3));
		expect(result).toEqual(Ok(15));
	});

	it("short-circuits on Err and does not call fn", () => {
		const fn = vi.fn();
		const result = andThenSync(Err("INVALID"), fn);

		expect(result).toEqual(Err("INVALID"));
		expect(fn).not.toHaveBeenCalled();
	});

	it("propagates errors returned by fn", () => {
		const result = andThenSync(Ok(42), () => Err({ type: "HANDLER_ERROR" }));
		expect(result).toEqual(Err({ type: "HANDLER_ERROR" }));
	});

	it("is composable with mapOk", () => {
		const result = andThenSync(
			mapOk(Ok(5), (n) => n + 1),
			(n) => (n > 5 ? Ok(n) : Err("TOO_SMALL")),
		);
		expect(result).toEqual(Ok(6));
	});
});
