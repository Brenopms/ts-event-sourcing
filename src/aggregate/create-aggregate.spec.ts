import { describe, expect, it } from "vitest";
import { Err, Ok } from "../core";
import type { EventStore } from "../event-store";
import { createAggregate } from "./create-aggregate";
import type { AggregateDefinition } from "./types/aggregate-definition";

describe("createAggregate", () => {
	type State = { value: number };
	type Event = { type: "created"; value: number };

	const aggregate: AggregateDefinition<State, Event> = {
		initialState: { value: 0 },
		reduce: (state, event) => ({ value: state.value + event.value }),
	};

	it("creates a new aggregate when the stream does not exist", async () => {
		let appended = false;

		const store: EventStore<Event> = {
			async load() {
				return Ok({ type: "empty", lastVersion: 0, events: [] });
			},
			async append({ events }) {
				appended = true;
				return Ok({ lastVersion: events.length, events: [] });
			},
		};

		const result = await createAggregate({
			store,
			streamId: "stream-1",
			aggregate,
			events: [{ type: "created", value: 10 }],
			idempotencyKey: "create-1",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.lastVersion).toBe(1);
		}
		expect(appended).toBe(true);
	});

	it("fails if the aggregate already exists", async () => {
		const store: EventStore<Event> = {
			async load() {
				return Ok({
					type: "loaded",
					events: [{ type: "created", value: 1 }],
					lastVersion: 1,
				});
			},
			async append() {
				throw new Error("append should not be called");
			},
		};

		const result = await createAggregate({
			store,
			streamId: "existing-stream",
			aggregate,
			events: [{ type: "created", value: 10 }],
			idempotencyKey: "create-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("AGGREGATE_ALREADY_EXISTS");
		}
	});

	it("wraps store load errors as STORE_ERROR", async () => {
		const storeError = { type: "LOAD_FAILED" };

		const store: EventStore<Event> = {
			async load() {
				return Err(storeError as any);
			},
			async append() {
				throw new Error("append should not be called");
			},
		};

		const result = await createAggregate({
			store,
			streamId: "stream-1",
			aggregate,
			events: [{ type: "created", value: 10 }],
			idempotencyKey: "create-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("STORE_ERROR");
			expect((result.error as any).cause).toBe(storeError);
		}
	});

	it("wraps store append errors as STORE_ERROR", async () => {
		const storeError = { type: "APPEND_FAILED" };

		const store: EventStore<Event> = {
			async load() {
				return Ok({ type: "empty", lastVersion: 0, events: [] });
			},
			async append() {
				return Err(storeError as any);
			},
		};

		const result = await createAggregate({
			store,
			streamId: "stream-1",
			aggregate,
			events: [{ type: "created", value: 10 }],
			idempotencyKey: "create-1",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("STORE_ERROR");
			expect((result.error as any).cause).toBe(storeError);
		}
	});

	it("does not attempt to append when the stream already exists", async () => {
		let appendCalled = false;

		const store: EventStore<Event> = {
			async load() {
				return Ok({
					type: "loaded",
					events: [],
					lastVersion: 0,
				});
			},
			async append() {
				appendCalled = true;
				return Ok({ lastVersion: 0, events: [] });
			},
		};

		await createAggregate({
			store,
			streamId: "stream-1",
			aggregate,
			events: [{ type: "created", value: 10 }],
			idempotencyKey: "create-1",
		});

		expect(appendCalled).toBe(false);
	});
});
