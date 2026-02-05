import { describe, expect, it } from "vitest";
import { Err, Ok } from "../core";
import type { EventStore } from "../event-store";
import { type Projection, project } from "../project";

type TestEvent =
	| { type: "INC"; value: number }
	| { type: "DEC"; value: number };

const projection: Projection<number, TestEvent> = {
	initialState: 0,
	fold: (state, event) =>
		event.type === "INC" ? state + event.value : state - event.value,
};

describe("project", () => {
	it("rebuilds projection state from events", async () => {
		const store: EventStore<TestEvent> = {
			load: async () =>
				Ok({
					type: "loaded",
					events: [
						{ type: "INC", value: 5 },
						{ type: "DEC", value: 2 },
					],
					lastVersion: 2,
				}),
			append: async () => {
				throw new Error("not used");
			},
		};

		const result = await project({
			store,
			streamId: "test",
			projection,
		});

		if (!result.ok) throw new Error("Expected ok result");

		expect(result.ok).toBe(true);
		expect(result.value).toEqual({
			state: 3,
			lastVersion: 2,
		});
	});

	it("supports partial projection rebuilds using toVersion", async () => {
		let receivedToVersion: number | undefined;

		const store: EventStore<TestEvent> = {
			load: async ({ toVersion }) => {
				receivedToVersion = toVersion;
				return Ok({
					type: "loaded",
					events: [{ type: "INC", value: 10 }],
					lastVersion: 1,
				});
			},
			append: async () => {
				throw new Error("not used");
			},
		};

		const result = await project({
			store,
			streamId: "test",
			projection,
			options: { toVersion: 1 },
		});

		if (!result.ok) throw new Error("Expected ok result");

		expect(receivedToVersion).toBe(1);
		expect(result.ok).toBe(true);
		expect(result.value.state).toBe(10);
	});

	it("returns STREAM_NOT_FOUND when the stream does not exist", async () => {
		const store: EventStore<TestEvent> = {
			load: async () => Err({ type: "STREAM_NOT_FOUND" }),
			append: async () => {
				throw new Error("not used");
			},
		};

		const result = await project({
			store,
			streamId: "missing",
			projection,
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ type: "STREAM_NOT_FOUND" });
	});

	it("wraps non-stream store errors as STORE_ERROR", async () => {
		const store: EventStore<TestEvent> = {
			load: async () => Err({ type: "IO_ERROR" } as any),
			append: async () => {
				throw new Error("not used");
			},
		};

		const result = await project({
			store,
			streamId: "test",
			projection,
		});

		if (result.ok) throw new Error("Expected error result");

		expect(result.ok).toBe(false);
		expect(result.error.type).toBe("STORE_ERROR");
	});
});
