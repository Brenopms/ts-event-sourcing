import { type AggregateDefinition, rebuildAggregate } from "../aggregate";
import type { CommandHandler } from "../command";
import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

/**
 * Executes a command against an existing aggregate stream.
 *
 * This function implements the canonical **event-sourcing command flow**:
 *
 * 1. Load the event stream from the store
 * 2. Rebuild the aggregate state by folding past events
 * 3. Execute the command handler to decide new events
 * 4. Append the decided events with optimistic concurrency control
 * 5. Rebuild the aggregate again from the authoritative event list
 *
 * ### Guarantees
 * - The returned `state` is always derived from persisted events
 * - No mutation happens if the command handler fails
 * - Concurrency is enforced via `expectedVersion`
 *
 * ### Failure modes
 * - `StreamNotFound` if the stream does not exist
 * - `StoreError` if the event store fails to load or append
 * - Any domain error returned by the command handler
 *
 * @typeParam State   Aggregate state type
 * @typeParam Event   Event union type
 * @typeParam Command Command input type
 * @typeParam Error   Domain error type produced by the handler
 *
 * @param params.store Event store used to load and append events
 * @param params.aggregate Aggregate definition (initial state + reducer)
 * @param params.streamId Stream identifier
 * @param params.command Command to execute
 * @param params.idempotencyKey Key used to guarantee append idempotency
 * @param params.handler Pure command handler (decision function)
 *
 * @returns A Result containing:
 * - `state`: the updated aggregate state
 * - `events`: events produced by the command
 * - `lastVersion`: the new stream version
 */
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
		CoreError | Error
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
		return Err({ type: "StreamNotFound" });
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
		return { ok: false, error: decision.error };
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
		return appendResult;
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
