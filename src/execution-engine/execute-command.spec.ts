import { describe, expect, it, vi } from "vitest";
import { CoreError, Err, Ok } from "../core";
import { executeCommand } from "./execute-command";

const aggregate = {
	initialState: { count: 0 },
	reduce: (state: { count: number }, _event: { type: "INC" }) => ({
		count: state.count + 1,
	}),
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
			append: vi.fn().mockResolvedValue(Err({ message: "db down" })),
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
});
