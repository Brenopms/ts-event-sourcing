import { describe, expect, it } from "vitest";
import { fold } from "./fold";

describe("fold", () => {
	it("returns the initial state when no events are provided", () => {
		const result = fold(0, (state, event: number) => state + event, []);

		expect(result).toBe(0);
	});

	it("applies events in order using the reducer", () => {
		const result = fold(0, (state, event: number) => state + event, [1, 2, 3]);

		expect(result).toBe(6);
	});

	it("supports non-commutative reducers (order matters)", () => {
		const result = fold("", (state, event: string) => state + event, [
			"a",
			"b",
			"c",
		]);

		expect(result).toBe("abc");
	});

	it("does not mutate the initial state", () => {
		const initial = { count: 0 };

		const result = fold(
			initial,
			(state, event: number) => ({
				count: state.count + event,
			}),
			[1, 2],
		);

		expect(result).toEqual({ count: 3 });
		expect(initial).toEqual({ count: 0 });
	});

	it("works with complex state and event shapes", () => {
		type State = { balance: number };
		type Event =
			| { type: "deposit"; amount: number }
			| { type: "withdraw"; amount: number };

		const result = fold<State, Event>(
			{ balance: 0 },
			(state, event) => {
				switch (event.type) {
					case "deposit":
						return { balance: state.balance + event.amount };
					case "withdraw":
						return { balance: state.balance - event.amount };
				}
			},
			[
				{ type: "deposit", amount: 100 },
				{ type: "withdraw", amount: 40 },
			],
		);

		expect(result.balance).toBe(60);
	});
});
