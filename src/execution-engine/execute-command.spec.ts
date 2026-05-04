import { describe, expect, it, vi } from "vitest";
import { CoreError, Err, Ok, Result } from "../core";
import { executeCommand } from "./execute-command";

// A normal aggregate that works
const aggregate = {
	initialState: { count: 0 },
	reduce: (state: { count: number }, _event: { type: "INC" }) => ({
		count: state.count + 1,
	}),
};

// An aggregate whose reducer throws during rebuild
const throwingAggregate = {
	initialState: { count: 0 },
	reduce: () => {
		throw new Error("Reducer crashed");
	},
};

function loadedStream(events: any[] = [], lastVersion = events.length) {
	return {
		ok: true,
		value: {
			type: "loaded",
			events,
			lastVersion,
		},
	};
}

describe("executeCommand function", () => {
	it("executes a command and returns new state, events and version", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream([{ type: "INC" }], 1)),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 2 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([{ type: "INC" }]));

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: { type: "increment" },
			idempotencyKey: "abc",
			handler,
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.value.events).toEqual([{ type: "INC" }]);
			expect(result.value.lastVersion).toBe(2);
			expect(result.value.state.count).toBe(2);
		}

		expect(store.append).toHaveBeenCalledWith({
			streamId: "account-1",
			expectedVersion: 1,
			idempotencyKey: "abc",
			events: [{ type: "INC" }],
		});
	});

	it("returns StreamNotFound if the stream does not exist", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(Ok({ type: "empty" })),
			append: vi.fn(),
		};

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "missing",
			command: {},
			idempotencyKey: "abc",
			handler: vi.fn(),
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect((result.error as CoreError).type).toBe("StreamNotFound");
	});

	it("returns handler error without appending events", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream()),
			append: vi.fn(),
		};

		const handler = vi.fn().mockReturnValue(Err({ type: "INVALID_COMMAND" }));

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
		});

		expect(result.ok).toBe(false);
		expect(store.append).not.toHaveBeenCalled();
	});

	it("returns StoreError if append fails", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream()),
			append: vi
				.fn()
				.mockResolvedValue(Err({ type: "StoreError", message: "db down" })),
		};

		const handler = vi.fn().mockReturnValue(Ok([{ type: "INC" }]));

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect((result.error as CoreError).type).toBe("StoreError");
	});

	it("returns ReducerError when initial rebuild throws", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream([{ type: "INC" }], 1)),
			append: vi.fn(),
		};

		const handler = vi.fn().mockReturnValue(Ok([{ type: "INC" }]));

		const result: Result<any, CoreError> = await executeCommand({
			store,
			aggregate: throwingAggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		if (!result?.ok) {
			expect(result.error.type).toBe("ReducerError");
			if (result.error.type !== "ReducerError") {
				throw new Error("Expected ReducerError but got " + result.error.type);
			}

			expect((result.error.cause as Error).message).toBe("Reducer crashed");
			expect(result.error?.cause).toBeInstanceOf(Error);
			expect(store.append).not.toHaveBeenCalled();
		}
	});

	it("returns ReducerError when final rebuild (after append) throws", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream([{ type: "INC" }], 1)),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 2 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([{ type: "INC" }]));

		// We need an aggregate that succeeds on the initial rebuild but throws on the second.
		// Since rebuildAggregate is called with the same aggregate both times,
		// we simulate by letting the first call succeed and the second throw.
		// However, we can't easily mock rebuildAggregate. Alternative: make the reducer
		// throw only when the state passes a certain threshold (e.g., count > 1).
		// For simplicity, we'll create a reducer that throws on the second call.
		let callCount = 0;
		const conditionalThrowingAggregate = {
			initialState: { count: 0 },
			reduce: (state: { count: number }, _event: { type: "INC" }) => {
				callCount++;
				if (callCount === 2) {
					throw new Error("Final rebuild crashed");
				}
				return { count: state.count + 1 };
			},
		};

		const result: Result<any, CoreError> = await executeCommand({
			store,
			aggregate: conditionalThrowingAggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect(result.error.type).toBe("ReducerError");
		if (result.error.type !== "ReducerError") {
			throw new Error("Expected ReducerError but got " + result.error.type);
		}

		expect(result.error.cause).toBeInstanceOf(Error);
		expect((result.error.cause as Error).message).toBe("Final rebuild crashed");
		// Append should have been called because initial rebuild succeeded
		expect(store.append).toHaveBeenCalled();
	});
});
