import type { Result } from "../types/result";

export const Ok = <T>(value: T): Result<T, never> => ({
	ok: true,
	value,
});

export const Err = <E>(error: E): Result<never, E> => ({
	ok: false,
	error,
});
