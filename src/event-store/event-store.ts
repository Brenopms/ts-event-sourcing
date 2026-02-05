import type { AnyEvent, CoreError, Result } from "../core";

/**
 * An event as persisted by the event store.
 *
 * Persisted events extend domain events with a monotonically
 * increasing version assigned by the store.
 *
 * @typeParam E Domain event type
 */
export type PersistedEvent<E extends AnyEvent> = E & {
	/**
	 * Version of the event within its stream.
	 */
	version: number;
};

/**
 * Represents a non-existent event stream.
 *
 * This is returned when a stream has never been created.
 * It is distinct from an empty but existing aggregate.
 */
export type EmptyStream = {
	type: "empty";
	lastVersion: 0;
	events: [];
};

/**
 * Represents an existing event stream with persisted events.
 *
 * Events are guaranteed to be ordered and contiguous
 * from version 1 to `lastVersion`.
 *
 * @typeParam E Domain event type
 */
export type LoadedStream<E> = {
	type: "loaded";
	lastVersion: number;
	events: E[];
};

/**
 * Discriminated union representing the state of an event stream.
 *
 * - `empty`: stream does not exist
 * - `loaded`: stream exists and contains events
 *
 * @typeParam E Domain event type
 */
export type StreamState<E> = EmptyStream | LoadedStream<E>;

/**
 * Event store interface.
 *
 * The event store is responsible for:
 * - Persisting events in order
 * - Enforcing optimistic locking
 * - Enforcing idempotency
 *
 * This interface is intentionally minimal and side-effect free.
 * Adapters are responsible for:
 * - Persistence
 * - Concurrency
 * - Idempotency guarantees
 *
 * ### Load semantics
 * - Returns `empty` if the stream does not exist
 * - Returns `loaded` if the stream exists
 * - Events must be returned in order
 *
 * ### Append semantics
 * - `expectedVersion` MUST match the stream's current version
 * - Appends MUST be atomic
 * - Duplicate `idempotencyKey`s MUST NOT re-append events
 *
 * @typeParam E Domain event type
 */
export interface EventStore<E extends AnyEvent> {
	load(params: {
		streamId: string;
		toVersion?: number;
	}): Promise<Result<StreamState<E>, CoreError>>;

	append(params: {
		streamId: string;
		expectedVersion: number;
		events: readonly E[];
		idempotencyKey: string;
	}): Promise<
		Result<
			{
				events: readonly PersistedEvent<E>[];
				lastVersion: number;
			},
			CoreError
		>
	>;
}
