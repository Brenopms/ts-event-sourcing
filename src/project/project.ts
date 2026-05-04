import {
	type AnyEvent,
	type CoreError,
	Err,
	fold,
	Ok,
	type Result,
} from "../core";
import type { EventStore } from "../event-store";

/**
 * A pull-based projection definition.
 *
 * A projection represents a **read model** derived from an event stream.
 * Unlike aggregates, projections:
 *
 * - Are allowed to be lossy or denormalized
 * - Do not enforce invariants
 * - Are rebuilt exclusively via event folding
 *
 * Projections are intentionally synchronous and deterministic.
 * Side effects must be handled outside of the core.
 *
 * @typeParam S Projection state
 * @typeParam E Event union
 */
export type Projection<S, E extends AnyEvent> = {
	initialState: S;
	fold: (state: S, event: E) => S;
};

/**
 * Rebuilds a pull-based projection by folding events from an event stream.
 *
 * A projection is a **read model** derived from events. This function loads
 * events from the store and deterministically folds them into a projection
 * state.
 *
 * Projections are intentionally:
 * - Pure (no side effects)
 * - Synchronous in their folding logic
 * - Rebuilt on demand (no internal caching)
 *
 * ### Behavior
 * - Events are loaded in order from the store
 * - The projection state is rebuilt by folding all loaded events
 * - The resulting state and last processed version are returned
 *
 * ### Partial rebuilds
 * The optional `toVersion` parameter allows rebuilding the projection
 * up to a specific event version. This is useful for:
 * - Time-travel queries
 * - Debugging
 * - Snapshot-based extensions
 *
 * ### Failure modes
 * - Returns `StreamNotFound` if the event stream does not exist
 * - Returns `StoreError` for any other event store failure
 *
 * ### Design notes
 * - Projections do not enforce invariants
 * - Projections do not distinguish between "aggregate exists" and
 *   "aggregate is valid" — only stream existence matters
 * - Snapshotting and caching are intentionally out of scope
 *
 * @typeParam S Projection state
 * @typeParam E Event union
 *
 * @param params.store Event store used to load events
 * @param params.streamId Stream identifier
 * @param params.projection Projection definition (initial state + fold)
 * @param params.options Optional configuration
 * @param params.options.toVersion Maximum event version to project (inclusive)
 *
 * @returns A Result containing:
 * - `state`: the rebuilt projection state
 * - `lastVersion`: the last processed event version
 */
export async function project<S, E extends AnyEvent>(params: {
	store: EventStore<E>;
	streamId: string;
	projection: Projection<S, E>;
	options?: { toVersion?: number };
}): Promise<Result<{ state: S; lastVersion: number }, CoreError>> {
	const { store, streamId, projection, options } = params;

	const loadResult = await store.load({
		streamId,
		toVersion: options?.toVersion,
	});

	if (!loadResult.ok) {
		return loadResult; // propagate the original CoreError as-is
	}

	const { events, lastVersion } = loadResult.value;

	let state: S;
	try {
		state = fold(projection.initialState, projection.fold, events);
	} catch (e) {
		return Err({ type: "FoldError", cause: e });
	}

	return Ok({ state, lastVersion });
}
