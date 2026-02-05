import {
  Err,
  fold,
  Ok,
  type AnyEvent,
  type CoreError,
  type Result,
} from "../core";
import type { EventStore } from "../event-store";

export type Projection<S, E extends AnyEvent> = {
  initialState: S;
  fold: (state: S, event: E) => S;
};

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
    if (loadResult.error.type === "STREAM_NOT_FOUND") {
      return Err({ type: "STREAM_NOT_FOUND" });
    }

    return Err({ type: "STORE_ERROR", cause: loadResult.error });
  }

  const { events, lastVersion } = loadResult.value;

  const state = fold(projection.initialState, projection.fold, events);

  return Ok({ state, lastVersion });
}
