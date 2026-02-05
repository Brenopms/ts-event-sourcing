import { type AggregateDefinition, rebuildAggregate } from "../aggregate";
import type { CommandHandler } from "../command";
import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

export async function executeCommand<
	State,
	Event extends AnyEvent,
	Command,
	Error,
>(params: {
	store: EventStore<Event>;
	aggregate: AggregateDefinition<State, Event>;
	streamId: string;
	command: Command;
	idempotencyKey: string;
	handler: CommandHandler<State, Command, Event, Error>;
}): Promise<
	Result<
		{
			state: State;
			events: readonly Event[];
			lastVersion: number;
		},
		CoreError
	>
> {
	// 1. Load stream
	const loaded = await params.store.load({
		streamId: params.streamId,
	});

	if (!loaded.ok) {
		return loaded;
	}

	if (loaded.value.type !== "loaded") {
		return Err({ type: "STREAM_NOT_FOUND" });
	}

	// 2. Rebuild state
	const state = rebuildAggregate({
		aggregate: params.aggregate,
		stream: loaded.value,
	});

	// 3. Decide
	const decision = params.handler({
		state,
		command: params.command,
	});

	if (!decision.ok) {
		// biome-ignore lint/suspicious/noExplicitAny: result type is not important for executing command
		return decision as Result<any, CoreError>;
	}

	const events = decision.value;

	// 4. Append
	const appendResult = await params.store.append({
		streamId: params.streamId,
		expectedVersion: loaded.value.lastVersion,
		idempotencyKey: params.idempotencyKey,
		events,
	});

	if (!appendResult.ok) {
		return Err({
			type: "STORE_ERROR",
			cause: appendResult.error,
		});
	}

	// 5. Rebuild again (authoritative)
	const nextState = rebuildAggregate({
		aggregate: params.aggregate,
		stream: {
			...loaded.value,
			events: [...loaded.value.events, ...events],
			lastVersion: appendResult.value.lastVersion,
		},
	});

	return Ok({
		state: nextState,
		events,
		lastVersion: appendResult.value.lastVersion,
	});
}
