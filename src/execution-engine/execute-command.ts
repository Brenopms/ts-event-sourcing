import {
	type AggregateDefinition,
	type AggregateLoader,
	rebuildAggregate,
} from "../aggregate";
import type { CommandHandler } from "../command";
import {
	type AnyEvent,
	type CoreError,
	Err,
	fold,
	Ok,
	type Result,
} from "../core";
import type { EventStore } from "../event-store";

/**
 * Executes a command against an existing aggregate stream.
 *
 * This function implements the canonical **event-sourcing command flow**:
 *
 * 1. Load aggregate state (either via the store + full replay, or via a
 *    custom `loader` such as a snapshot-aware loader)
 * 2. Execute the command handler to decide new events
 * 3. Append the decided events with optimistic concurrency control
 * 4. Incrementally fold new events into the loaded state
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
 * - Any error produced by the `loader` (when provided)
 *
 * @typeParam State   Aggregate state type
 * @typeParam Event   Event union type
 * @typeParam Command Command input type
 * @typeParam Error   Domain error type produced by the handler
 * @typeParam LoaderError Error type produced by the optional loader
 *
 * @param params.store Event store used to append events (and load, if no loader)
 * @param params.aggregate Aggregate definition (initial state + reducer)
 * @param params.streamId Stream identifier
 * @param params.command Command to execute
 * @param params.idempotencyKey Key used to guarantee append idempotency
 * @param params.handler Pure command handler (decision function)
 * @param params.loader Optional aggregate loader (e.g. snapshot-aware loader)
 *
 * @returns A Result containing:
 *  - `state`: the updated aggregate state
 *  - `events`: events produced by the command
 *  - `lastVersion`: the new stream version
 */
export async function executeCommand<
	State,
	Event extends AnyEvent,
	Command,
	Error,
	LoaderError = never,
>(params: {
	store: EventStore<Event>;
	aggregate: AggregateDefinition<State, Event>;
	streamId: string;
	command: Command;
	idempotencyKey: string;
	handler: CommandHandler<State, Command, Event, Error>;
	loader?: AggregateLoader<State, Event, LoaderError>;
}): Promise<
	Result<
		{
			state: State;
			events: readonly Event[];
			lastVersion: number;
		},
		CoreError | Error | LoaderError
	>
> {
	const {
		store,
		aggregate,
		streamId,
		command,
		idempotencyKey,
		handler,
		loader,
	} = params;

	// 1. Load aggregate (loader or default full replay)
	const loadResult = loader
		? await loader({ store, aggregate, streamId })
		: await loadFromStore(store, aggregate, streamId);

	if (!loadResult.ok) {
		return loadResult;
	}

	const { state, lastVersion } = loadResult.value;

	// 2. Decide
	const decision = handler({ state, command });

	if (!decision.ok) {
		return { ok: false, error: decision.error };
	}

	const events = decision.value;

	// 3. Append
	const appendResult = await store.append({
		streamId,
		expectedVersion: lastVersion,
		idempotencyKey,
		events,
	});

	if (!appendResult.ok) {
		return appendResult;
	}

	// 4. authoritative rebuild from events, including the appended ones
	let nextState: State;

	try {
		nextState = fold(state, aggregate.reduce, events);
	} catch (e) {
		return Err({ type: "ReducerError", cause: e });
	}

	return Ok({
		state: nextState,
		events,
		lastVersion: appendResult.value.lastVersion,
	});
}

async function loadFromStore<State, Event extends AnyEvent>(
	store: EventStore<Event>,
	aggregate: AggregateDefinition<State, Event>,
	streamId: string,
): Promise<Result<{ state: State; lastVersion: number }, CoreError>> {
	const loaded = await store.load({ streamId });

	if (!loaded.ok) {
		return loaded;
	}

	if (loaded.value.type !== "loaded") {
		return Err({ type: "StreamNotFound" });
	}

	let state: State;
	try {
		state = rebuildAggregate({
			aggregate,
			stream: loaded.value,
		});
	} catch (e) {
		return Err({ type: "ReducerError", cause: e });
	}

	return Ok({ state, lastVersion: loaded.value.lastVersion });
}
