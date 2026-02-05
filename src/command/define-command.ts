import type { AggregateDefinition } from "../aggregate";
import type { AnyEvent, CoreError, Result } from "../core";
import type { EventStore } from "../event-store";
import { executeCommand } from "../execution-engine";

import type { CommandHandler } from "./command-handler";

export function defineCommand<S, C, E extends AnyEvent, Err>(params: {
	aggregate: AggregateDefinition<S, E>;
	handler: CommandHandler<S, C, E, Err | CoreError>;
}) {
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
