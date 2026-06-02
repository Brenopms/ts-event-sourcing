export type CoreError =
	| { type: "StreamNotFound" }
	| { type: "ConcurrencyConflict"; expected: number; actual: number }
	| { type: "IdempotencyViolation" }
	| { type: "StoreError"; cause: unknown }
	| { type: "ReducerError"; cause: unknown }
	| { type: "FoldError"; cause: unknown }
	| { type: "AggregateAlreadyExists" }
	| { type: "AggregateNotFound" }
	| {
			type: "InvalidVersionRange";
			fromVersion: number;
			toVersion: number;
	  };
