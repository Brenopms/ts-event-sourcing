export type CoreError =
  | { type: "StreamNotFound" }
  | { type: "ConcurrencyConflict"; expected: number; actual: number }
  | { type: "IdempotencyViolation" }
  | { type: "StoreError"; cause: unknown }
  | { type: "ReducerError"; cause: unknown }
  | { type: "HandlerError"; cause: unknown }
  | { type: "STREAM_NOT_FOUND" }
  | { type: "STORE_ERROR"; cause: unknown }
  | { type: "AGGREGATE_ALREADY_EXISTS" }
  | { type: "AGGREGATE_NOT_FOUND" };
