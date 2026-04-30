export type CoreError =
	| { type: "StreamNotFound" }
	| { type: "ConcurrencyConflict"; expected: number; actual: number }
	| { type: "IdempotencyViolation" }
	| { type: "StoreError"; cause: unknown }
	| { type: "AggregateAlreadyExists" }
	| { type: "AggregateNotFound" };
