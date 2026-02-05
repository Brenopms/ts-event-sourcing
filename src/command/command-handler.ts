import { type AggregateDefinition, loadAggregate } from "../aggregate";
import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

export type CommandHandler<
	State,
	Command,
	Event extends AnyEvent,
	Error,
> = (params: {
	state: State;
	command: Command;
}) => Result<readonly Event[], Error>;

export async function handleCommand<
	State,
	Command,
	Event extends AnyEvent,
	Error,
>(params: {
	store: EventStore<Event>;
	streamId: string;
	aggregate: AggregateDefinition<State, Event>;
	command: Command;
	idempotencyKey: string;
	handler: CommandHandler<State, Command, Event, Error>;
}): Promise<Result<{ lastVersion: number }, Error | CoreError>> {
	const loaded = await loadAggregate({
		store: params.store,
		streamId: params.streamId,
		aggregate: params.aggregate,
	});

	if (!loaded.ok) return loaded;

	const decision = params.handler({
		state: loaded.value.state,
		command: params.command,
	});

	if (!decision.ok) {
		return decision;
	}

	if (decision.value.length === 0) {
		return Ok({ lastVersion: loaded.value.lastVersion });
	}

	const appendResult = await params.store.append({
		streamId: params.streamId,
		expectedVersion: loaded.value.lastVersion,
		idempotencyKey: params.idempotencyKey,
		events: decision.value,
	});

	if (!appendResult.ok) {
		return Err({ type: "STORE_ERROR", cause: appendResult.error });
	}

	return Ok({ lastVersion: appendResult.value.lastVersion });
}
