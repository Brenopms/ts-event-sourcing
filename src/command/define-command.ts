import type { AggregateDefinition } from "../aggregate";
import type { AnyEvent, CoreError, Result } from "../core";
import type { EventStore } from "../event-store";
import { executeCommand } from "../execution-engine";
import { CommandHandler } from "./command-handler";

export type DefinedCommand<S, C, E extends AnyEvent, Err> = {
	execute(input: {
		store: EventStore<E>;
		streamId: string;
		command: C;
		idempotencyKey: string;
	}): Promise<
		Result<
			{
				state: S;
				events: readonly E[];
				lastVersion: number;
			},
			Err | CoreError
		>
	>;
};

/**
 * Defines an executable command bound to a specific aggregate.
 *
 * This helper wires together:
 * - an aggregate definition
 * - a pure command handler
 * - the command execution engine
 *
 * It returns an object with an `execute` method that can be called
 * with infrastructure concerns (store, stream id, idempotency key).
 *
 * ### Purpose
 * `defineCommand` exists purely for **ergonomics and safety**:
 * - Removes boilerplate from calling `executeCommand`
 * - Ensures the command is always executed against the correct aggregate
 * - Preserves full type inference for state, command, events, and errors
 *
 * ### Design notes
 * - This function does not introduce new behavior
 * - It is a thin wrapper around `executeCommand`
 * - All invariants and guarantees are enforced by the underlying engine
 *
 * @typeParam S Aggregate state
 * @typeParam C Command type
 * @typeParam E Event union
 * @typeParam Err Domain-specific error type
 *
 * @param params.aggregate Aggregate definition the command applies to
 * @param params.handler Pure command handler
 *
 * @returns An object exposing an `execute` function for running the command
 */
export function defineCommand<S, C, E extends AnyEvent, Err>(params: {
	aggregate: AggregateDefinition<S, E>;
	handler: CommandHandler<S, C, E, Err | CoreError>;
}): DefinedCommand<S, C, E, Err> {
	return {
		execute: (exec: {
			store: EventStore<E>;
			streamId: string;
			command: C;
			idempotencyKey: string;
		}): Promise<
			Result<
				{
					state: S;
					events: readonly E[];
					lastVersion: number;
				},
				Err | CoreError
			>
		> => {
			return executeCommand({
				store: exec.store,
				streamId: exec.streamId,
				aggregate: params.aggregate,
				command: exec.command,
				idempotencyKey: exec.idempotencyKey,
				handler: params.handler,
			});
		},
	};
}
