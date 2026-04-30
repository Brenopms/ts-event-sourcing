import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";
import type { AggregateDefinition } from ".";
import { rebuildAggregate } from "./rebuild-aggregate";

/**
 * Loads an aggregate from the event store and rebuilds its current state.
 *
 * This function represents the boundary between infrastructure (event store)
 * and pure domain logic (aggregate rebuild). It is responsible for:
 *
 * - Loading the event stream from the store
 * - Translating store errors into core errors
 * - Rejecting non-existent aggregates
 * - Rebuilding aggregate state deterministically
 *
 * ### Invariants
 * - The store is the source of truth
 * - Aggregate state is always derived from events
 * - The returned version corresponds to the last applied event
 *
 * ### Failure semantics
 * - Returns `AggregateNotFound` if the stream is empty
 * - Wraps store errors as `StoreError`
 * - Never throws
 *
 * ### Notes
 * - This function does not create aggregates
 * - Stream initialization must be handled explicitly elsewhere
 * - Snapshotting can be layered on top of this function
 *
 * @typeParam S - Aggregate state type
 * @typeParam E - Aggregate event type
 * @param params.store - Event store implementation
 * @param params.streamId - Aggregate stream identifier
 * @param params.aggregate - Aggregate definition
 * @returns A Result containing the rebuilt state and last version, or a CoreError
 */
export async function loadAggregate<S, E extends AnyEvent>(params: {
	store: EventStore<E>;
	streamId: string;
	aggregate: AggregateDefinition<S, E>;
}): Promise<
	Result<
		{
			state: S;
			lastVersion: number;
		},
		CoreError
	>
> {
	const { store, streamId, aggregate } = params;

	const loadResult = await store.load({ streamId });

	if (!loadResult.ok) {
		return Err({
			type: "StoreError",
			cause: loadResult.error,
		});
	}

	const stream = loadResult.value;

	if (stream.type === "empty") {
		return Err({ type: "AggregateNotFound" });
	}

	const state = rebuildAggregate<S, E>({
		aggregate,
		stream,
	});

	return Ok({
		state,
		lastVersion: stream.lastVersion,
	});
}
