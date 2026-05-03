import type { AnyEvent } from "../core";
import type { EventMatcher } from "./match-event";

export function matchEventPartial<E extends AnyEvent, T extends E["type"], R>(
	event: Extract<E, { type: T }>,
	matcher: Partial<EventMatcher<E, R>>,
): R | undefined {
	const handler = matcher[event.type];
	if (handler) {
		return handler(event);
	}
}
