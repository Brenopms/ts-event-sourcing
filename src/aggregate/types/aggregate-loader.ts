import type { AnyEvent, Result } from "../../core";
import type { EventStore } from "../../event-store";
import type { AggregateDefinition } from "./aggregate-definition";

/**
 * A pluggable aggregate loading strategy.
 *
 * `AggregateLoader` is a function type that abstracts the aggregate loading
 * step inside `executeCommand`. It replaces the default sequence of
 * (store.load → rebuildAggregate) with a custom strategy — such as
 * snapshot-accelerated loading, cached replay, or multi-stream composition.
 *
 * ### Contract
 * - Receives the `store`, `aggregate`, and `streamId`
 * - Returns `Result<{ state, lastVersion }, LoaderError>`
 * - Must produce the same `{ state, lastVersion }` as a full replay would
 *
 * ### Default
 * When `LoaderError = never`, no additional errors are introduced into
 * the error union. Snapshot loaders (e.g. from `@ts-event-sourcing/snapshots`)
 * will set `LoaderError = CoreError | SnapshotError`.
 *
 * @typeParam State   Aggregate state type
 * @typeParam Event   Aggregate event type
 * @typeParam LoaderError Error type produced by this loader (default `never`)
 */
export type AggregateLoader<
	State,
	Event extends AnyEvent,
	LoaderError = never,
> = (params: {
	store: EventStore<Event>;
	aggregate: AggregateDefinition<State, Event>;
	streamId: string;
}) => Promise<
	Result<
		{
			state: State;
			lastVersion: number;
		},
		LoaderError
	>
>;
