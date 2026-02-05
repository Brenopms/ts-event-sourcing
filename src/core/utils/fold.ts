export function fold<S, E>(
  initial: S,
  reduce: (state: S, event: E) => S,
  events: readonly E[]
): S {
  let state = initial;
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}
