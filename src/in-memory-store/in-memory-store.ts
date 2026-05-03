import type { AnyEvent, CoreError, Result } from "../core";
import { Err, Ok } from "../core";
import type { EventStore, PersistedEvent, StreamState } from "../event-store";

/**
 * In-memory reference implementation of EventStore.
 *
 *  NOT intended for production use.
 *
 * This store exists to:
 * - Define the canonical event-store semantics
 * - Enable local development and testing
 * - Serve as a reference for other store implementations
 *
 * It provides:
 * - Optimistic locking via version
 * - Idempotency enforcement
 * - Deterministic event ordering
 *
 * It does NOT provide:
 * - Durability
 * - Cross-process safety
 * - High concurrency guarantees
 */
export class InMemoryEventStore<E extends AnyEvent> implements EventStore<E> {
	private streams = new Map<
		string,
		{
			events: PersistedEvent<E>[];
			version: number;
			idempotencyKeys: Set<string>;
		}
	>();

	async load(params: {
		streamId: string;
		toVersion?: number;
	}): Promise<Result<StreamState<E>, CoreError>> {
		const { streamId, toVersion } = params;
		const stream = this.streams.get(streamId);

		if (!stream) {
			return Ok({ type: "empty", lastVersion: 0, events: [] });
		}

		const filteredEvents =
			toVersion === undefined
				? [...stream.events]
				: stream.events
						.filter((e) => e.version <= toVersion)
						.map((e) => ({ ...e }));

		if (filteredEvents.length === 0) {
			return Ok({ type: "loaded", events: [], lastVersion: 0 });
		}

		return Ok({
			type: "loaded",
			events: filteredEvents,
			lastVersion: filteredEvents[filteredEvents.length - 1].version,
		});
	}

	async append(params: {
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
	> {
		const { streamId, expectedVersion, events, idempotencyKey } = params;

		let stream = this.streams.get(streamId);

		if (!stream) {
			if (expectedVersion !== 0) {
				return Err({
					type: "ConcurrencyConflict",
					expected: expectedVersion,
					actual: 0,
				});
			}

			stream = {
				events: [],
				version: 0,
				idempotencyKeys: new Set(),
			};
			this.streams.set(streamId, stream);
		}

		if (stream.idempotencyKeys.has(idempotencyKey)) {
			return Err({ type: "IdempotencyViolation" });
		}

		if (stream.version !== expectedVersion) {
			return Err({
				type: "ConcurrencyConflict",
				expected: expectedVersion,
				actual: stream.version,
			});
		}

		//Create new arrays instead of mutating
		const newEvents: PersistedEvent<E>[] = [];
		let currentVersion = stream.version;

		for (const event of events) {
			currentVersion++;
			newEvents.push({ ...event, version: currentVersion });
		}

		const updatedEvents = [...stream.events, ...newEvents];
		const updatedStream = {
			events: updatedEvents,
			version: currentVersion,
			idempotencyKeys: new Set([...stream.idempotencyKeys, idempotencyKey]),
		};
		this.streams.set(streamId, updatedStream);

		return Ok({
			events: newEvents,
			lastVersion: currentVersion,
		});
	}
}
