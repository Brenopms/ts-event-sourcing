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
 * - Range-based loading via fromVersion (exclusive) and toVersion (inclusive)
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

	private validateVersionRange(
		fromVersion?: number,
		toVersion?: number,
	): Result<void, CoreError> {
		if (fromVersion !== undefined && fromVersion < 0) {
			return Err({
				type: "InvalidVersionRange",
				fromVersion,
				toVersion: toVersion ?? 0,
			});
		}

		if (toVersion !== undefined && toVersion < 0) {
			return Err({
				type: "InvalidVersionRange",
				fromVersion: fromVersion ?? 0,
				toVersion,
			});
		}

		if (
			fromVersion !== undefined &&
			toVersion !== undefined &&
			fromVersion > toVersion
		) {
			return Err({
				type: "InvalidVersionRange",
				fromVersion,
				toVersion,
			});
		}

		return Ok(undefined);
	}

	async load(params: {
		streamId: string;
		fromVersion?: number;
		toVersion?: number;
	}): Promise<Result<StreamState<E>, CoreError>> {
		const { streamId, fromVersion, toVersion } = params;

		const versionValidationResult = this.validateVersionRange(
			fromVersion,
			toVersion,
		);

		if (!versionValidationResult.ok) {
			return versionValidationResult;
		}

		const stream = this.streams.get(streamId);

		if (!stream) {
			return Ok({ type: "empty", lastVersion: 0, events: [] });
		}

		let filteredEvents = [...stream.events];

		filteredEvents = filteredEvents.filter(
			(e) =>
				(fromVersion === undefined || e.version > fromVersion) &&
				(toVersion === undefined || e.version <= toVersion),
		);

		if (filteredEvents.length === 0) {
			return Ok({ type: "loaded", events: [], lastVersion: stream.version });
		}

		return Ok({
			type: "loaded",
			events: filteredEvents,
			lastVersion: stream.version,
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
