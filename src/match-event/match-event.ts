import type { AnyEvent } from "../core";

export type EventMatcher<E extends AnyEvent, R> = {
	[K in E["type"]]: (event: Extract<E, { type: K }>) => R;
};

/**
 * Exhaustively matches a domain event by its `type`.
 *
 * This helper provides a **type-safe alternative to switch/case** when
 * working with discriminated union events.
 *
 * It guarantees at compile time that:
 * - Every possible `event.type` is handled
 * - The handler receives the correctly narrowed event shape
 *
 * ### Usage
 * ```ts
 * matchEvent(event, {
 *   USER_CREATED: e => e.userId,
 *   USER_DELETED: e => e.reason,
 * });
 * ```
 *
 * ### Design notes
 * - This function is intentionally minimal and synchronous
 * - Runtime behavior assumes the matcher is exhaustive (enforced by TypeScript)
 * - No default case is supported by design
 *
 * @typeParam E Full event union
 * @typeParam T Specific event `type` being matched
 * @typeParam R Return type of the matcher functions
 *
 * @param event The event instance to match
 * @param matcher An object mapping event types to handler functions
 *
 * @returns The result of the matched handler
 */
export function matchEvent<E extends AnyEvent, T extends E["type"], R>(
	event: Extract<E, { type: T }>,
	matcher: EventMatcher<E, R>,
): R {
	return matcher[event.type](event);
}
