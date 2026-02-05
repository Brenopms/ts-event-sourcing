import { type AnyEvent, fold } from "../core";
import type { LoadedStream } from "../event-store";

import type { AggregateDefinition } from ".";

/**
 * Rebuilds the aggregate state from a loaded event stream.
 *
 * This is a domain-level helper that binds together an `AggregateDefinition`
 * and a `LoadedStream` to produce the current derived state.
 *
 * Internally, this function delegates to `fold`, but it exists as a named
 * abstraction to encode **intent**:
 * - rebuilding an aggregate
 * - from its initial state
 * - using its reducer
 * - over a concrete stream of events
 *
 * ### Invariants
 * - The aggregate reducer must be pure and deterministic
 * - The stream events must be ordered by version
 * - The returned state is fully derived from the stream
 *
 * ### Failure semantics
 * - This function never fails and never throws
 * - Any stream or store errors must be handled before calling it
 *
 * ### Why this exists
 * - Provides semantic clarity over calling `fold` directly
 * - Establishes a stable extension point (e.g. snapshots)
 * - Centralizes aggregate rebuild semantics
 *
 * @typeParam S - Aggregate state type
 * @typeParam E - Aggregate event type
 * @param params.aggregate - The aggregate definition (initial state + reducer)
 * @param params.stream - A loaded event stream
 * @returns The rebuilt aggregate state
 */
export function rebuildAggregate<S, E extends AnyEvent>(params: {
	aggregate: AggregateDefinition<S, E>;
	stream: LoadedStream<E>;
}): S {
	const { aggregate, stream } = params;

	return fold(aggregate.initialState, aggregate.reduce, stream.events);
}
