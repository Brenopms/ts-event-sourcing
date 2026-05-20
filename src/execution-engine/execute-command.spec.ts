import { describe, expect, it, vi } from "vitest";
import { CoreError, Err, Ok, Result } from "../core";
import { executeCommand } from "./execute-command";

const aggregate = {
	initialState: { count: 0 },
	reduce: (state: { count: number }, _event: { type: "INC" }) => ({
		count: state.count + 1,
	}),
};

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

function successfulLoader(state = { count: 1 }, lastVersion = 5) {
	return vi.fn().mockResolvedValue(Ok({ state, lastVersion }));
}

const INC_EVENT = { type: "INC" as const };

describe("executeCommand function", () => {
	it("executes a command and returns new state, events and version", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream([INC_EVENT], 1)),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 2 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));

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
			expect(result.value.events).toEqual([INC_EVENT]);
			expect(result.value.lastVersion).toBe(2);
			expect(result.value.state.count).toBe(2);
		}

		expect(store.append).toHaveBeenCalledWith({
			streamId: "account-1",
			expectedVersion: 1,
			idempotencyKey: "abc",
			events: [INC_EVENT],
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

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));

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
			load: vi.fn().mockResolvedValue(loadedStream([INC_EVENT], 1)),
			append: vi.fn(),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));

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
		expect(result.error.type).toBe("ReducerError");
		expect((result.error as any).cause).toBeInstanceOf(Error);
		expect((result.error as any).cause.message).toBe("Reducer crashed");
		expect(store.append).not.toHaveBeenCalled();
	});

	it("returns ReducerError when final rebuild (after append) throws", async () => {
		const store = {
			load: vi.fn().mockResolvedValue(loadedStream([INC_EVENT], 1)),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 2 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));

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
		expect((result.error as any).cause).toBeInstanceOf(Error);
		expect((result.error as any).cause.message).toBe("Final rebuild crashed");
		expect(store.append).toHaveBeenCalled();
	});
});

describe("executeCommand with loader", () => {
	it("executes a command via the loader and returns new state", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 7 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));
		const loader = successfulLoader({ count: 3 }, 6);

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: { type: "increment" },
			idempotencyKey: "abc",
			handler,
			loader,
		});

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.value.state.count).toBe(4);
			expect(result.value.events).toEqual([INC_EVENT]);
			expect(result.value.lastVersion).toBe(7);
		}

		expect(loader).toHaveBeenCalledWith({
			store,
			aggregate,
			streamId: "account-1",
		});

		expect(store.append).toHaveBeenCalledWith({
			streamId: "account-1",
			expectedVersion: 6,
			idempotencyKey: "abc",
			events: [INC_EVENT],
		});

		expect(store.load).not.toHaveBeenCalled();
	});

	it("propagates loader error", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn(),
		};

		const loader = vi.fn().mockResolvedValue(Err({ type: "SNAPSHOT_ERROR" }));

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler: vi.fn(),
			loader,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as any).type).toBe("SNAPSHOT_ERROR");
			expect(store.append).not.toHaveBeenCalled();
		} else {
			throw new Error("Should have thrown snapshot error");
		}
	});

	it("returns handler error without appending when using loader", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn(),
		};

		const handler = vi.fn().mockReturnValue(Err({ type: "INVALID_COMMAND" }));
		const loader = successfulLoader();

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
			loader,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as any).type).toBe("INVALID_COMMAND");
			expect(store.append).not.toHaveBeenCalled();
		}
	});

	it("returns StoreError when append fails with loader", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn().mockResolvedValue(Err({ type: "StoreError" })),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));
		const loader = successfulLoader();

		const result = await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
			loader,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as any).type).toBe("StoreError");
		}
	});

	it("returns ReducerError when incremental fold throws with loader", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 7 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([INC_EVENT]));

		const throwingReducerAggregate = {
			initialState: { count: 0 },
			reduce: () => {
				throw new Error("Fold crashed");
			},
		};

		const loader = successfulLoader();

		const result = await executeCommand({
			store,
			aggregate: throwingReducerAggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
			loader,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as any).type).toBe("ReducerError");
			expect((result.error as any).cause).toBeInstanceOf(Error);
			expect((result.error as any).cause.message).toBe("Fold crashed");
		}
		expect(store.append).toHaveBeenCalled();
	});

	it("does not call store.load when loader is provided", async () => {
		const store = {
			load: vi.fn(),
			append: vi.fn().mockResolvedValue(Ok({ lastVersion: 1 })),
		};

		const handler = vi.fn().mockReturnValue(Ok([]));
		const loader = successfulLoader();

		await executeCommand({
			store,
			aggregate,
			streamId: "account-1",
			command: {},
			idempotencyKey: "abc",
			handler,
			loader,
		});

		expect(store.load).not.toHaveBeenCalled();
	});
});
