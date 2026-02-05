import { fold, type AnyEvent } from "../core";
import type { LoadedStream } from "../event-store";

import type { AggregateDefinition } from ".";

export function rebuildAggregate<S, E extends AnyEvent>(params: {
  aggregate: AggregateDefinition<S, E>;
  stream: LoadedStream<E>;
}): S {
  const { aggregate, stream } = params;

  return fold(aggregate.initialState, aggregate.reduce, stream.events);
}
