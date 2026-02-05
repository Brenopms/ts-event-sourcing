import {
	type AggregateDefinition,
	defineCommand,
	Err,
	type EventStore,
	InMemoryEventStore,
	matchEvent,
	Ok,
	type Projection,
	project,
	rebuildAggregate,
} from "../src";
import { createAggregate } from "../src/aggregate/create-aggregate";
import type { CommandHandler } from "../src/command";

type AccountOpened = {
	type: "AccountOpened";
	data: {
		ownerId: string;
	};
};

type MoneyDeposited = {
	type: "MoneyDeposited";
	data: {
		amount: number;
	};
};

type MoneyWithdrawn = {
	type: "MoneyWithdrawn";
	data: {
		amount: number;
	};
};

type AccountEvent = AccountOpened | MoneyDeposited | MoneyWithdrawn;

type AccountState = {
	ownerId: string;
	balance: number;
};

const accountAggregate: AggregateDefinition<AccountState, AccountEvent> = {
	initialState: {
		ownerId: "",
		balance: 0,
	},

	reduce: (state, event) =>
		matchEvent(event, {
			AccountOpened: (e) => ({
				ownerId: e.data.ownerId,
				balance: 0,
			}),

			MoneyDeposited: (e) => ({
				...state,
				balance: state.balance + e.data.amount,
			}),

			MoneyWithdrawn: (e) => ({
				...state,
				balance: state.balance - e.data.amount,
			}),
		}),
};

type DepositMoney = {
	amount: number;
};

type WithdrawMoney = {
	amount: number;
};

type AccountError = { type: "INVALID_AMOUNT" } | { type: "INSUFFICIENT_FUNDS" };

const depositMoneyHandler: CommandHandler<
	AccountState,
	DepositMoney,
	AccountEvent,
	AccountError
> = ({ command }) => {
	if (command.amount <= 0) {
		return Err({ type: "INVALID_AMOUNT" });
	}

	return Ok([
		{
			type: "MoneyDeposited",
			data: { amount: command.amount },
		},
	]);
};

const withdrawMoneyHandler: CommandHandler<
	AccountState,
	WithdrawMoney,
	AccountEvent,
	AccountError
> = ({ state, command }) => {
	if (command.amount <= 0) {
		return Err({ type: "INVALID_AMOUNT" });
	}

	if (state.balance < command.amount) {
		return Err({ type: "INSUFFICIENT_FUNDS" });
	}

	return Ok([
		{
			type: "MoneyWithdrawn",
			data: { amount: command.amount },
		},
	]);
};

const depositMoney = defineCommand({
	aggregate: accountAggregate,
	handler: depositMoneyHandler,
});

const withdrawMoney = defineCommand({
	aggregate: accountAggregate,
	handler: withdrawMoneyHandler,
});

async function openAccount(params: {
	store: EventStore<AccountEvent>;
	accountId: string;
	ownerId: string;
	idempotencyKey: string;
}) {
	return createAggregate({
		store: params.store,
		streamId: params.accountId,
		idempotencyKey: params.idempotencyKey,
		aggregate: accountAggregate,
		events: [
			{
				type: "AccountOpened",
				data: { ownerId: params.ownerId },
			},
		],
	});
}

type AccountBalanceProjection = {
	balance: number;
};

const accountBalanceProjection: Projection<
	AccountBalanceProjection,
	AccountEvent
> = {
	initialState: { balance: 0 },

	fold: (state, event) =>
		matchEvent(event, {
			AccountOpened: () => ({ balance: 0 }),

			MoneyDeposited: (e) => ({
				balance: state.balance + e.data.amount,
			}),

			MoneyWithdrawn: (e) => ({
				balance: state.balance - e.data.amount,
			}),
		}),
};

const store = new InMemoryEventStore<AccountEvent>();

await openAccount({
	store,
	accountId: "acc-1",
	ownerId: "breno",
	idempotencyKey: "open-1",
});

await depositMoney.execute({
	store,
	streamId: "acc-1",
	command: { amount: 100 },
	idempotencyKey: "dep-1",
});

await withdrawMoney.execute({
	store,
	streamId: "acc-1",
	command: { amount: 40 },
	idempotencyKey: "wd-1",
});

const loaded = await store.load({ streamId: "acc-1" });

if (loaded.ok && loaded.value.type === "loaded") {
	const state = rebuildAggregate({
		aggregate: accountAggregate,
		stream: loaded.value,
	});

	console.log(state);
	// → { ownerId: "breno", balance: 60 }
}

// Projection before withdraw
const projected = await project({
	store,
	streamId: "acc-1",
	projection: accountBalanceProjection,
	options: { toVersion: 2 },
});

if (projected.ok) {
	console.log(projected.value.state.balance);
	// → balance after first 2 events
}

const loadedBeforeWithdraw = await store.load({
	streamId: "acc-1",
	toVersion: 2,
});

if (loadedBeforeWithdraw.ok && loadedBeforeWithdraw.value.type === "loaded") {
	const stateBeforeWithdraw = rebuildAggregate({
		aggregate: accountAggregate,
		stream: loadedBeforeWithdraw.value,
	});

	console.log(stateBeforeWithdraw);
	// → { ownerId: "breno", balance: 100 }
}
