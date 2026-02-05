import { describe, expect, it } from "vitest";
import type { LoadedStream } from "../event-store";
import type { AggregateDefinition } from ".";
import { rebuildAggregate } from "./rebuild-aggregate";

describe("rebuildAggregate", () => {
	it("rebuilds state from the aggregate initial state and stream events", () => {
		type State = { count: number };
		type Event = { type: "increment"; value: number };

		const aggregate: AggregateDefinition<State, Event> = {
			initialState: { count: 0 },
			reduce(state, event) {
				return { count: state.count + event.value };
			},
		};

		const stream: LoadedStream<Event> = {
			type: "loaded",
			events: [
				{ type: "increment", value: 1 },
				{ type: "increment", value: 2 },
			],
			lastVersion: 2,
		};

		const state = rebuildAggregate({ aggregate, stream });

		expect(state).toEqual({ count: 3 });
	});

	it("returns the initial state when the stream has no events", () => {
		type State = { balance: number };
		type Event = { type: "noop" };

		const aggregate: AggregateDefinition<State, Event> = {
			initialState: { balance: 0 },
			reduce: (state) => state,
		};

		const stream: LoadedStream<Event> = {
			type: "loaded",
			events: [],
			lastVersion: 0,
		};

		const state = rebuildAggregate({ aggregate, stream });

		expect(state).toEqual({ balance: 0 });
	});

	it("does not mutate the aggregate initial state", () => {
		type State = { value: number };
		type Event = { type: "add"; amount: number };

		const initialState: State = { value: 0 };

		const aggregate: AggregateDefinition<State, Event> = {
			initialState,
			reduce(state, event) {
				return { value: state.value + event.amount };
			},
		};

		const stream: LoadedStream<Event> = {
			type: "loaded",
			events: [{ type: "add", amount: 10 }],
			lastVersion: 1,
		};

		const state = rebuildAggregate({ aggregate, stream });

		expect(state).toEqual({ value: 10 });
		expect(initialState).toEqual({ value: 0 });
	});

	it("ignores stream metadata and only folds over events", () => {
		type State = number;
		type Event = { type: "add"; value: number };

		const aggregate: AggregateDefinition<State, Event> = {
			initialState: 0,
			reduce: (state, event) => state + event.value,
		};

		const stream: LoadedStream<Event> = {
			type: "loaded",
			events: [{ type: "add", value: 5 }],
			lastVersion: 42,
		};

		const state = rebuildAggregate({ aggregate, stream });

		expect(state).toBe(5);
	});
});
