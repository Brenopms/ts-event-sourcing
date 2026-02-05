import { Err, Ok, type AnyEvent, type CoreError, type Result } from "../core";
import type { EventStore } from "../event-store";

import { rebuildAggregate } from "./rebuild-aggregate";

import type { AggregateDefinition } from ".";

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
      type: "STORE_ERROR",
      cause: loadResult.error,
    });
  }

  const stream = loadResult.value;

  if (stream.type === "empty") {
    return Err({ type: "AGGREGATE_NOT_FOUND" });
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
