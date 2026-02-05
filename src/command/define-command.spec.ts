import { describe, expect, it } from "vitest";
import type { AggregateDefinition } from "../aggregate";
import { Ok } from "../core";
import type { EventStore } from "../event-store";
import type { CommandHandler } from "./command-handler";
import { defineCommand } from "./define-command";

type TestEvent = { type: "INC"; value: number };
type TestCommand = { value: number };

const aggregate: AggregateDefinition<number, TestEvent> = {
	initialState: 0,
	reduce: (state, event) => state + event.value,
};

describe("defineCommand", () => {
	it("executes a command using the provided aggregate and handler", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [],
					lastVersion: 0,
				}),
			append: async ({ events }) =>
				Ok({ lastVersion: events.length, events: [] }),
		};

		const handler: CommandHandler<number, TestCommand, TestEvent, never> = ({
			command,
		}) => Ok([{ type: "INC", value: command.value }]);

		const command = defineCommand({
			aggregate,
			handler,
		});

		const result = await command.execute({
			store,
			streamId: "test",
			command: { value: 3 },
			idempotencyKey: "idemp",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected ok result");

		expect(result.value.state).toBe(3);
		expect(result.value.events).toEqual([{ type: "INC", value: 3 }]);
		expect(result.value.lastVersion).toBe(1);
	});

	it("propagates domain errors from the command handler", async () => {
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
		> = () => ({
			ok: false,
			error: "INVALID",
		});

		const command = defineCommand({
			aggregate,
			handler,
		});

		const result = await command.execute({
			store,
			streamId: "test",
			command: { value: 1 },
			idempotencyKey: "idemp",
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected error result");

		expect(result.error).toBe("INVALID");
	});

	it("does not leak execution-engine details to the caller", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [],
					lastVersion: 0,
				}),
			append: async ({ events }) =>
				Ok({ lastVersion: events.length, events: [] }),
		};

		const handler: CommandHandler<number, TestCommand, TestEvent, never> = ({
			command,
		}) => Ok([{ type: "INC", value: command.value }]);

		const command = defineCommand({
			aggregate,
			handler,
		});

		// Type-level assertion: caller only provides infra + command
		const result = await command.execute({
			store,
			streamId: "test",
			command: { value: 2 },
			idempotencyKey: "idemp",
		});

		expect(result.ok).toBe(true);
	});
});
