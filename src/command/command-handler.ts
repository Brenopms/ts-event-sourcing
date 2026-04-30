import { type AnyEvent, type Result } from "../core";

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
