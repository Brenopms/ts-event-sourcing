import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

import type { AggregateDefinition } from "./types/aggregate-definition";

export async function createAggregate<S, E extends AnyEvent>(params: {
	store: EventStore<E>;
	streamId: string;
	aggregate: AggregateDefinition<S, E>;
	events: readonly E[];
	idempotencyKey: string;
}): Promise<Result<{ lastVersion: number }, CoreError>> {
	const { store, streamId, events, idempotencyKey } = params;

	const loadResult = await store.load({ streamId });

	if (!loadResult.ok) {
		return Err({
			type: "STORE_ERROR",
			cause: loadResult.error,
		});
	}

	const stream = loadResult.value;

	if (stream.type === "loaded") {
		return Err({ type: "AGGREGATE_ALREADY_EXISTS" });
	}

	const appendResult = await store.append({
		streamId,
		expectedVersion: 0,
		events,
		idempotencyKey,
	});

	if (!appendResult.ok) {
		return Err({
			type: "STORE_ERROR",
			cause: appendResult.error,
		});
	}

	return Ok({
		lastVersion: events.length,
	});
}
