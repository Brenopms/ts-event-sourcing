import type { AnyEvent } from "../../core";

export type Reducer<State, Event extends AnyEvent> = (
	state: State,
	event: Event,
) => State;
