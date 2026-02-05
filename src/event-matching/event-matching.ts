import type { AnyEvent } from "../core";

export type EventMatcher<E extends AnyEvent, R> = {
  [K in E["type"]]: (event: Extract<E, { type: K }>) => R;
};

export function matchEvent<E extends AnyEvent, T extends E["type"], R>(
  event: Extract<E, { type: T }>,
  matcher: EventMatcher<E, R>,
): R {
  return matcher[event.type](event);
}
