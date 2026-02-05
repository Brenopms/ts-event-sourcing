import { type AggregateDefinition, loadAggregate } from "../aggregate";
import { type AnyEvent, type CoreError, Err, Ok, type Result } from "../core";
import type { EventStore } from "../event-store";

/**
 * A pure command handler responsible for deciding which events
 * should be emitted for a given command and aggregate state.
 *
 * Command handlers:
 * - Must be deterministic
 * - Must not perform side effects
 * - Must not interact with the event store
 *
 * Returning an error represents a **domain decision failure**
 * (e.g. invariant violation).
 *
 * Returning an empty event list represents a **no-op command**.
 *
 * @typeParam State Aggregate state
 * @typeParam Command Command type
 * @typeParam Event Event union
 * @typeParam Error Domain-specific error type
 */
export type CommandHandler<
	State,
	Command,
	Event extends AnyEvent,
	Error,
> = (params: {
	state: State;
	command: Command;
}) => Result<readonly Event[], Error>;


/**
 * Executes a command against an existing aggregate.
 *
 * This function orchestrates the full command execution flow:
 *
 * 1. Loads and rebuilds the aggregate state
 * 2. Delegates decision-making to the command handler
 * 3. Appends produced events with optimistic locking
 *
 * ### Guarantees
 * - Aggregate state is rebuilt deterministically
 * - Optimistic locking is enforced via `expectedVersion`
 * - Idempotency is delegated to the event store
 *
 * ### No-op commands
 * If the command handler returns an empty event list, no append
 * is performed and the current version is returned.
 *
 * ### Failure modes
 * - Returns domain errors produced by the command handler
 * - Returns `AGGREGATE_NOT_FOUND` if the stream does not exist
 * - Returns `STORE_ERROR` for event store failures
 *
 * ### Design notes
 * - Command handlers are pure and side-effect free
 * - This function does not rebuild state after append
 * - Snapshotting is intentionally out of scope
 *
 * @typeParam State Aggregate state
 * @typeParam Command Command type
 * @typeParam Event Event union
 * @typeParam Error Domain-specific error type
 *
 * @returns A Result containing the new aggregate version
 */
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
