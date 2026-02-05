import type { AnyEvent } from "../../core";

import type { Reducer } from "./reducer";

export type AggregateDefinition<State, Event extends AnyEvent> = {
	initialState: State;
	reduce: Reducer<State, Event>;
};
