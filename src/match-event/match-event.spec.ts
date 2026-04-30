/** biome-ignore-all lint/suspicious/noEmptyBlockStatements: used for testing */
import { describe, expect, it, vi } from "vitest";
import { type EventMatcher, matchEvent } from "./match-event";

type TestEvent =
	| { type: "CREATED"; id: string }
	| { type: "UPDATED"; value: number }
	| { type: "DELETED"; reason: string };

describe("matchEvent", () => {
	it("calls the handler corresponding to the event type", () => {
		const event: TestEvent = { type: "UPDATED", value: 42 };

		const created = vi.fn();
		const updated = vi.fn().mockReturnValue("ok");
		const deleted = vi.fn();

		const result = matchEvent(event as TestEvent, {
			CREATED: created,
			UPDATED: updated,
			DELETED: deleted,
		});

		expect(result).toBe("ok");
		expect(updated).toHaveBeenCalledWith(event);
		expect(created).not.toHaveBeenCalled();
		expect(deleted).not.toHaveBeenCalled();
	});

	it("supports arbitrary return types", () => {
		const event: TestEvent = { type: "CREATED", id: "1" };

		const matcher: EventMatcher<TestEvent, string | number> = {
			CREATED: (e) => e.id,
			UPDATED: (e) => e.value,
			DELETED: (e) => e.reason,
		};

		const result = matchEvent(event, matcher);
		expect(result).toBe("1");
	});

	it("propagates errors thrown by the handler", () => {
		const event: TestEvent = { type: "DELETED", reason: "boom" };

		expect(() =>
			matchEvent(event as TestEvent, {
				CREATED: () => {},
				UPDATED: () => {},
				DELETED: () => {
					throw new Error("fail");
				},
			}),
		).toThrow("fail");
	});
});
