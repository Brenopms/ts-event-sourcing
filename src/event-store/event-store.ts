import type { AnyEvent, CoreError, Result } from "../core";

export type PersistedEvent<E extends AnyEvent> = E & {
  version: number;
};

export type EmptyStream = {
  type: "empty";
  lastVersion: 0;
  events: [];
};

export type LoadedStream<E> = {
  type: "loaded";
  lastVersion: number;
  events: E[];
};

export type StreamState<E> = EmptyStream | LoadedStream<E>;

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
