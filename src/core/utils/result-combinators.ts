import type { Result } from "../types/result";
import { Ok } from "./result-wrappers";

/**
 * Extracts the success value from a Result, throwing the error if it failed.
 *
 * Use this at the boundary of code that has already validated the result,
 * or in test helpers where a failure is genuinely unexpected.
 *
 * ⚠️  Do not use this in production pipelines — prefer `mapOk` or `andThen`
 * so that errors stay in-band and are handled explicitly.
 *
 * @throws The error value if `result.ok` is false
 *
 * @example
 * const value = unwrap(Ok(42));         // → 42
 * const boom  = unwrap(Err("oops"));   // throws "oops"
 */
export function unwrap<T, E>(result: Result<T, E>): T {
	if (!result.ok) {
		throw result.error;
	}
	return result.value;
}

// ─── mapOk ────────────────────────────────────────────────────────────────────

/**
 * Transforms the success value of a Result without touching the error path.
 *
 * If the result is an error, it is passed through unchanged.
 * The transformation function `fn` is only called on success.
 *
 * This is the synchronous equivalent of `Promise.then` for Result types.
 *
 * @example
 * const result = Ok(3);
 * const doubled = mapOk(result, n => n * 2);   // Ok(6)
 * const failed  = mapOk(Err("bad"), n => n * 2); // Err("bad")
 */
export function mapOk<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => U,
): Result<U, E> {
	if (!result.ok) {
		return result;
	}
	return Ok(fn(result.value));
}

// ─── andThen ─────────────────────────────────────────────────────────────────

/**
 * Chains an async operation that itself returns a Result.
 *
 * If the input result is a failure, the chain is short-circuited and the
 * error is propagated. The async function `fn` is only called on success.
 *
 * This is the core building block for pipeline-style error handling —
 * it lets you compose async steps that can each independently fail,
 * without nesting `if (!result.ok)` guards.
 *
 * @example
 * const result = await andThen(Ok("stream-1"), streamId =>
 *   store.load({ streamId })
 * );
 */
export async function andThen<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
	if (!result.ok) {
		return result;
	}
	return fn(result.value);
}

/**
 * Synchronous variant of `andThen`.
 *
 * Chains a synchronous operation that returns a Result.
 * Useful for pure domain logic steps (e.g. calling a command handler).
 *
 * @example
 * const result = andThenSync(Ok(state), s =>
 *   handler({ state: s, command })
 * );
 */
export function andThenSync<T, U, E>(
	result: Result<T, E>,
	fn: (value: T) => Result<U, E>,
): Result<U, E> {
	if (!result.ok) {
		return result;
	}
	return fn(result.value);
}
