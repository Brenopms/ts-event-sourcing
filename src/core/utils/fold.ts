/**
 * Deterministically rebuilds state by folding a sequence of events.
 *
 * `fold` is a pure function and the foundational primitive of the event-sourcing core.
 * Given an initial state, a reducer, and an ordered list of events, it applies the
 * reducer sequentially to produce the final derived state.
 *
 * ### Invariants
 * - Events are applied strictly in the order provided
 * - The reducer must be pure and deterministic
 * - The initial state is not mutated
 * - The returned state is fully derived from inputs
 *
 * ### Failure semantics
 * - This function never throws
 * - Any error handling must be encoded inside the reducer itself
 *
 * ### Typical usage
 * - Rebuilding aggregate state from an event stream
 * - Rebuilding projections
 * - Time-travel and partial rebuilds (by slicing events)
 *
 * @typeParam S - State type
 * @typeParam E - Event type
 * @param initial - The initial state before any events are applied
 * @param reduce - A pure reducer function describing state transitions
 * @param events - An ordered list of events to apply
 * @returns The final derived state after all events are folded
 */
export function fold<S, E>(
	initial: S,
	reduce: (state: S, event: E) => S,
	events: readonly E[],
): S {
	let state = initial;
	for (const event of events) {
		state = reduce(state, event);
	}
	return state;
}
