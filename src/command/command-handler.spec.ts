import { describe, expect, it, vi } from "vitest";
import type { AggregateDefinition } from "../aggregate";
import { Err, Ok } from "../core";
import type { EventStore } from "../event-store";
import { type CommandHandler, handleCommand } from "./command-handler";

type TestEvent = { type: "INC"; value: number };
type TestCommand = { value: number };

const aggregate: AggregateDefinition<number, TestEvent> = {
	initialState: 0,
	reduce: (state, event) => state + event.value,
};

describe("handleCommand", () => {
	it("executes a command and appends events", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [{ type: "INC", value: 1 }],
					lastVersion: 1,
				}),
			append: async ({ events }) =>
				Ok({ lastVersion: 1 + events.length, events: [] }),
		};

		const handler: CommandHandler<number, TestCommand, TestEvent, never> = ({
			command,
		}) => Ok([{ type: "INC", value: command.value }]);

		const result = await handleCommand({
			store,
			streamId: "test",
			aggregate,
			command: { value: 2 },
			idempotencyKey: "idemp",
			handler,
		});

        if (!result.ok) throw new Error("Expected ok result");

		expect(result.ok).toBe(true);
		expect(result.value.lastVersion).toBe(2);
	});

	it("returns domain error from command handler", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [],
					lastVersion: 0,
				}),
			append: async () => {
				throw new Error("not used");
			},
		};

		const handler: CommandHandler<
			number,
			TestCommand,
			TestEvent,
			"INVALID"
		> = () => Err("INVALID");

		const result = await handleCommand({
			store,
			streamId: "test",
			aggregate,
			command: { value: 1 },
			idempotencyKey: "idemp",
			handler,
		});

        if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect(result.error).toBe("INVALID");
	});

	it("does not append when handler returns no events", async () => {
		const append = vi.fn();

		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [],
					lastVersion: 3,
				}),
			append,
		};

		const handler: CommandHandler<number, TestCommand, TestEvent, never> = () =>
			Ok([]);

		const result = await handleCommand({
			store,
			streamId: "test",
			aggregate,
			command: { value: 1 },
			idempotencyKey: "idemp",
			handler,
		});

        if (!result.ok) throw new Error("Expected ok result");

		expect(result.ok).toBe(true);
		expect(result.value.lastVersion).toBe(3);
		expect(append).not.toHaveBeenCalled();
	});

	it("returns STORE_ERROR when append fails", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [],
					lastVersion: 0,
				}),
			append: async () => Err({ type: "StoreError", cause: "error" }),
		};

		const handler: CommandHandler<number, TestCommand, TestEvent, never> = () =>
			Ok([{ type: "INC", value: 1 }]);

		const result = await handleCommand({
			store,
			streamId: "test",
			aggregate,
			command: { value: 1 },
			idempotencyKey: "idemp",
			handler,
		});

        if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect(result.error.type).toBe("STORE_ERROR");
	});
});
