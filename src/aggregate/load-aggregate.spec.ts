import { describe, expect, it } from "vitest";
import { Err, Ok } from "../core";
import type { EventStore } from "../event-store";
import type { AggregateDefinition } from ".";
import { loadAggregate } from "./load-aggregate";

describe("loadAggregate", () => {
	type State = { count: number };
	type Event = { type: "increment"; value: number };

	const aggregate: AggregateDefinition<State, Event> = {
		initialState: { count: 0 },
		reduce(state, event) {
			return { count: state.count + event.value };
		},
	};

	it("loads the stream and rebuilds aggregate state", async () => {
		const store: EventStore<Event> = {
			async load() {
				return Ok({
					type: "loaded",
					events: [
						{ type: "increment", value: 1 },
						{ type: "increment", value: 2 },
					],
					lastVersion: 2,
				});
			},
			async append() {
				throw new Error("not used");
			},
		};

		const result = await loadAggregate({
			store,
			streamId: "stream-1",
			aggregate,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.state).toEqual({ count: 3 });
			expect(result.value.lastVersion).toBe(2);
		}
	});

	it("returns AGGREGATE_NOT_FOUND when the stream is empty", async () => {
		const store: EventStore<Event> = {
			async load() {
				return Ok({ type: "empty", lastVersion: 0, events: [] });
			},
			async append() {
				throw new Error("not used");
			},
		};

		const result = await loadAggregate({
			store,
			streamId: "missing-stream",
			aggregate,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("AGGREGATE_NOT_FOUND");
		}
	});

	it("wraps store load errors as STORE_ERROR", async () => {
		const storeError = { type: "CONNECTION_FAILED" };

		const store: EventStore<Event> = {
			async load() {
				return Err(storeError as any);
			},
			async append() {
				throw new Error("not used");
			},
		};

		const result = await loadAggregate({
			store,
			streamId: "stream-1",
			aggregate,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("STORE_ERROR");
			expect((result.error as any)?.cause).toBe(storeError);
		}
	});

	it("does not attempt to rebuild when load fails", async () => {
		let rebuildCalled = false;

		const aggregateWithSpy: AggregateDefinition<State, Event> = {
			initialState: { count: 0 },
			reduce(state, event) {
				rebuildCalled = true;
				return { count: state.count + event.value };
			},
		};

		const store: EventStore<Event> = {
			async load() {
				return Ok({ type: "empty", lastVersion: 0, events: [] });
			},
			async append() {
				throw new Error("not used");
			},
		};

		await loadAggregate({
			store,
			streamId: "stream-1",
			aggregate: aggregateWithSpy,
		});

		expect(rebuildCalled).toBe(false);
	});
});
