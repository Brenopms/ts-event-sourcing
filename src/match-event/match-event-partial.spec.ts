import { describe, expect, it, vi } from "vitest";
import { matchEventPartial } from "./match-event-partial";

type TestEvent =
	| { type: "USER_CREATED"; payload: { id: string } }
	| { type: "USER_DELETED"; payload: { id: string } };

describe("matchEventPartial", () => {
	it("should call the matching handler and return its result", () => {
		const event: TestEvent = {
			type: "USER_CREATED",
			payload: { id: "123" },
		};

		const handler = vi.fn().mockReturnValue("handled");

		const matcher = {
			USER_CREATED: handler,
		};

		const result = matchEventPartial(event, matcher);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(event);
		expect(result).toBe("handled");
	});

	it("should return undefined if no matching handler exists", () => {
		const event: TestEvent = {
			type: "USER_CREATED",
			payload: { id: "123" },
		};

		const matcher = {
			USER_DELETED: vi.fn(),
		};

		const result = matchEventPartial(event, matcher as any);

		expect(result).toBeUndefined();
	});

	it("should not call other handlers", () => {
		const event: TestEvent = {
			type: "USER_CREATED",
			payload: { id: "123" },
		};

		const createdHandler = vi.fn();
		const deletedHandler = vi.fn();

		const matcher = {
			USER_CREATED: createdHandler,
			USER_DELETED: deletedHandler,
		};

		matchEventPartial(event, matcher);

		expect(createdHandler).toHaveBeenCalledTimes(1);
		expect(deletedHandler).not.toHaveBeenCalled();
	});

	it("should work with an empty matcher", () => {
		const event: TestEvent = {
			type: "USER_CREATED",
			payload: { id: "123" },
		};

		const result = matchEventPartial(event, {});

		expect(result).toBeUndefined();
	});

	it("should pass the correctly narrowed event type to the handler", () => {
		const event: TestEvent = {
			type: "USER_DELETED",
			payload: { id: "999" },
		};

		const handler = vi.fn((e: Extract<TestEvent, { type: "USER_DELETED" }>) => {
			return e.payload.id;
		});

		const matcher = {
			USER_DELETED: handler,
		};

		const result = matchEventPartial(event, matcher);

		expect(handler).toHaveBeenCalledWith(event);
		expect(result).toBe("999");
	});
});
