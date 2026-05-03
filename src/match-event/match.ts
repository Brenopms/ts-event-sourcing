/** Extracts the discriminant value type from `T[K]`, narrowed to string | symbol. */
type DiscriminantValue<T, K extends keyof T> = T[K] extends string | symbol
	? T[K]
	: never;

/**
 * Narrows `T` to the branch where `T[K] === V`.
 *
 * Prefers `Extract` for proper discriminated unions (gives you the exact member),
 * falls back to `T & Record<K, V>` for plain interfaces (keeps all fields, narrows [K]).
 */
type NarrowByKey<T, K extends keyof T, V extends T[K]> =
	Extract<T, Record<K, V>> extends never
		? T & Record<K, V>
		: Extract<T, Record<K, V>>;

/**
 * Case map when `_` is present.
 *
 * Each specific handler is optional and may return its own type `RCases`.
 * The `_` handler returns its own type `RDefault`.
 * The function returns `RCases | RDefault`, so every handler's type contributes
 * independently — no unification collapses any branch to `never`.
 */
type CasesWithDefault<T, K extends keyof T, RCases, RDefault> = {
	_: (obj: T) => RDefault;
} & { [V in DiscriminantValue<T, K>]?: (obj: NarrowByKey<T, K, V>) => RCases };

/**
 * Case map without a default — every variant key is required (exhaustive match).
 */
type CasesExhaustive<T, K extends keyof T, R> = {
	[V in DiscriminantValue<T, K>]: (obj: NarrowByKey<T, K, V>) => R;
};

/**
 * A type-safe pattern matcher that branches on a discriminant key of an object.
 *
 * @param obj   - The object whose key is being matched
 * @param key   - The discriminant key (must be a key whose value extends string | symbol)
 * @param cases - An object mapping variant values to handlers, plus an optional `_` default
 * @returns       The union of all provided handler return types
 *
 * ---
 *
 * ### Type inference limitations
 *
 * **1. Using `_` (default case) returns `unknown`.**
 * When `_` is present, TypeScript cannot resolve `RCases` and `RDefault`
 * independently at the call site, so the inferred return type is `unknown`.
 * Cast the result to the expected type to recover type safety:
 *
 * ```ts
 * const result = match(state, "status", {
 *   Pending: (s) => Ok({ orderId: s.orderId }),
 *   _:       ()  => Err({ type: "InvalidStatus" as const }),
 * }) as Ok<{ orderId: string }> | Err<{ type: "InvalidStatus" }>;
 * ```
 *
 * **2. Plain interfaces require an `as` cast at the call site.**
 * TypeScript infers `T` from the argument's structural value type, not from
 * the variable's declared type. When `obj` is typed as a union but holds a
 * concrete value, only that concrete member's variants are generated, causing
 * extra case keys to be rejected. Cast to the union type to fix this:
 *
 * ```ts
 * // ❌ TypeScript infers T as the concrete member — other case keys are rejected
 * const s: Shape = { kind: "circle", radius: 5 };
 * match(s, "kind", { circle: ..., rect: ..., triangle: ... });
 *
 * // ✅ Cast forces T to be inferred as the full union
 * match(s as Shape, "kind", { circle: ..., rect: ..., triangle: ... });
 * ```
 *
 * ---
 *
 * @example — exhaustive (no default), all variants required:
 * ```ts
 * match(state, "status", {
 *   Pending:   (s) => Ok([{ type: "PaymentConfirmed", orderId: s.orderId }]),
 *   Confirmed: ()  => Err({ type: "OrderAlreadyConfirmed" }),
 *   Shipped:   ()  => Err({ type: "OrderAlreadyShipped" }),
 *   Delivered: ()  => Err({ type: "OrderAlreadyDelivered" }),
 *   Cancelled: ()  => Err({ type: "OrderAlreadyCancelled" }),
 * });
 * ```
 *
 * @example — partial with `_` default (return type is `unknown`, cast as needed):
 * ```ts
 * const result = match(state, "status", {
 *   Pending: (s) => Ok([{ type: "PaymentConfirmed", orderId: s.orderId }]),
 *   _:       ()  => Err({ type: "InvalidStatus" as const }),
 * }) as Ok<...> | Err<...>;
 * ```
 */
export function match<T, K extends keyof T, RCases, RDefault>(
	obj: T,
	key: K,
	cases: CasesWithDefault<T, K, RCases, RDefault>,
): RCases | RDefault;

export function match<T, K extends keyof T, R>(
	obj: T,
	key: K,
	cases: CasesExhaustive<T, K, R>,
): R;

export function match<T, K extends keyof T, R>(
	obj: T,
	key: K,
	cases: CasesWithDefault<T, K, R, R> | CasesExhaustive<T, K, R>,
): R {
	const discriminant = obj[key] as string | symbol;
	const handler = (cases as Record<string | symbol, ((o: T) => R) | undefined>)[
		discriminant
	];

	if (handler !== undefined) {
		return handler(obj as never);
	}

	const defaultHandler = (cases as { _?: (o: T) => R })._;
	if (defaultHandler !== undefined) {
		return defaultHandler(obj);
	}

	throw new Error(
		`[match] No case handled discriminant "${String(discriminant)}" on key "${String(key)}", and no default "_" was provided.`,
	);
}
