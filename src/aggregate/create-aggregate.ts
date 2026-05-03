import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

/**
 * Creates a new aggregate by initializing its event stream.
 *
 * This function is responsible for **explicit aggregate creation**.
 * It ensures that:
 *
 * - The aggregate does not already exist
 * - The stream is initialized exactly once
 * - Initial events are appended with optimistic locking
 * - Idempotency is enforced at the store level
 *
 * ### Invariants
 * - Aggregate creation is explicit and separate from command execution
 * - The initial stream version is always `0`
 * - The returned version equals the number of appended events
 *
 * ### Failure semantics
 * - Returns `AggregateAlreadyExists` if the stream already exists
 * - Wraps store load / append errors as `StoreError`
 * - Never throws
 *
 * ### Notes
 * - This function does not rebuild aggregate state
 * - Domain validation must be performed before calling it
 * - Snapshotting and projections are out of scope
 *
 * @typeParam S - Aggregate state type (unused, for symmetry and typing)
 * @typeParam E - Aggregate event type
 * @param params.store - Event store implementation
 * @param params.streamId - Aggregate stream identifier
 * @param params.aggregate - Aggregate definition (currently unused, reserved for symmetry)
 * @param params.events - Initial events to create the aggregate
 * @param params.idempotencyKey - Idempotency key for safe retries
 * @returns A Result containing the last version, or a CoreError
 */

export async function createAggregate<E extends AnyEvent>(params: {
	store: EventStore<E>;
	streamId: string;
	events: readonly E[];
	idempotencyKey: string;
}): Promise<Result<{ lastVersion: number }, CoreError>> {
	const { store, streamId, events, idempotencyKey } = params;

	const loadResult = await store.load({ streamId });

	if (!loadResult.ok) {
		return Err({
			type: "StoreError",
			cause: loadResult.error,
		});
	}

	const stream = loadResult.value;

	if (stream.type === "loaded") {
		return Err({ type: "AggregateAlreadyExists" });
	}

	const appendResult = await store.append({
		streamId,
		expectedVersion: 0,
		events,
		idempotencyKey,
	});

	if (!appendResult.ok) {
		return appendResult;
	}

	return Ok({
		lastVersion: appendResult.value.lastVersion,
	});
}
