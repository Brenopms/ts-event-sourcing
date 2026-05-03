import { describe, expect, it } from "vitest";
import {
	type AggregateDefinition,
	type CommandHandler,
	createAggregate,
	defineCommand,
	Err,
	InMemoryEventStore,
	loadAggregate,
	matchEvent,
	Ok,
	type Projection,
	project,
	unwrap,
} from "../";

// ─── Domain ────────────────────────────────────────────────────────────────

type PatientEvent =
	| {
			type: "PatientRegistered";
			patientId: string;
			name: string;
			dateOfBirth: Date;
	  }
	| {
			type: "AllergyRecorded";
			patientId: string;
			allergen: string;
			severity: "Mild" | "Moderate" | "Severe";
	  }
	| {
			type: "PrescriptionIssued";
			patientId: string;
			prescriptionId: string;
			drug: string;
			dosage: string;
			startDate: Date;
			endDate: Date;
	  }
	| {
			type: "EncounterStarted";
			patientId: string;
			encounterId: string;
			reason: string;
			startedAt: Date;
	  }
	| {
			type: "EncounterClosed";
			patientId: string;
			encounterId: string;
			notes: string;
			closedAt: Date;
	  };

type EncounterInfo = {
	encounterId: string;
	reason: string;
	startedAt: Date;
	status: "Open" | "Closed";
	notes?: string;
	closedAt?: Date;
};

type PatientState = {
	patientId: string;
	name: string;
	dateOfBirth: Date;
	allergies: Array<{ allergen: string; severity: string }>;
	prescriptions: Array<{
		prescriptionId: string;
		drug: string;
		dosage: string;
		startDate: Date;
		endDate: Date;
	}>;
	currentEncounter: EncounterInfo | null;
};

type PatientError =
	| { type: "PatientAlreadyRegistered" }
	| { type: "PatientNotFound" }
	| { type: "EncounterAlreadyOpen" }
	| { type: "NoOpenEncounter" }
	| { type: "AllergyConflict"; drug: string; allergen: string }
	| { type: "InvalidPrescriptionDates" }
	| { type: "DuplicatePrescriptionId" };

const patientAggregate: AggregateDefinition<PatientState, PatientEvent> = {
	initialState: {
		patientId: "",
		name: "",
		dateOfBirth: new Date(0),
		allergies: [],
		prescriptions: [],
		currentEncounter: null,
	},
	reduce: (state, event) =>
		matchEvent(event, {
			PatientRegistered: (e) => ({
				patientId: e.patientId,
				name: e.name,
				dateOfBirth: e.dateOfBirth,
				allergies: [],
				prescriptions: [],
				currentEncounter: null,
			}),
			AllergyRecorded: (e) => ({
				...state,
				allergies: [
					...state.allergies,
					{ allergen: e.allergen, severity: e.severity },
				],
			}),
			PrescriptionIssued: (e) => ({
				...state,
				prescriptions: [
					...state.prescriptions,
					{
						prescriptionId: e.prescriptionId,
						drug: e.drug,
						dosage: e.dosage,
						startDate: e.startDate,
						endDate: e.endDate,
					},
				],
			}),
			EncounterStarted: (e) => ({
				...state,
				currentEncounter: {
					encounterId: e.encounterId,
					reason: e.reason,
					startedAt: e.startedAt,
					status: "Open",
				},
			}),
			EncounterClosed: (e) => ({
				...state,
				currentEncounter: state.currentEncounter
					? {
							...state.currentEncounter,
							status: "Closed",
							notes: e.notes,
							closedAt: e.closedAt,
						}
					: null,
			}),
		}),
};

// ─── Command handlers ──────────────────────────────────────────────────────

const registerPatientHandler: CommandHandler<
	PatientState,
	{ patientId: string; name: string; dateOfBirth: Date },
	PatientEvent,
	PatientError
> = ({ command }) => Ok([{ type: "PatientRegistered", ...command }]);

const recordAllergyHandler: CommandHandler<
	PatientState,
	{ allergen: string; severity: "Mild" | "Moderate" | "Severe" },
	PatientEvent,
	PatientError
> = ({ state, command }) =>
	Ok([
		{
			type: "AllergyRecorded",
			patientId: state.patientId,
			allergen: command.allergen,
			severity: command.severity,
		},
	]);

const issuePrescriptionHandler: CommandHandler<
	PatientState,
	{
		prescriptionId: string;
		drug: string;
		dosage: string;
		startDate: Date;
		endDate: Date;
	},
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	if (
		state.prescriptions.some((p) => p.prescriptionId === command.prescriptionId)
	)
		return Err({ type: "DuplicatePrescriptionId" });

	const allergy = state.allergies.find((a) =>
		command.drug.toLowerCase().includes(a.allergen.toLowerCase()),
	);
	if (allergy)
		return Err({
			type: "AllergyConflict",
			drug: command.drug,
			allergen: allergy.allergen,
		});

	if (command.endDate <= command.startDate)
		return Err({ type: "InvalidPrescriptionDates" });

	return Ok([
		{ type: "PrescriptionIssued", patientId: state.patientId, ...command },
	]);
};

const startEncounterHandler: CommandHandler<
	PatientState,
	{ encounterId: string; reason: string; startedAt: Date },
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	if (state.currentEncounter?.status === "Open")
		return Err({ type: "EncounterAlreadyOpen" });
	return Ok([
		{
			type: "EncounterStarted",
			patientId: state.patientId,
			encounterId: command.encounterId,
			reason: command.reason,
			startedAt: command.startedAt,
		},
	]);
};

const closeEncounterHandler: CommandHandler<
	PatientState,
	{ notes: string; closedAt: Date },
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	if (!state.currentEncounter || state.currentEncounter.status !== "Open")
		return Err({ type: "NoOpenEncounter" });
	return Ok([
		{
			type: "EncounterClosed",
			patientId: state.patientId,
			encounterId: state.currentEncounter.encounterId,
			notes: command.notes,
			closedAt: command.closedAt,
		},
	]);
};

const registerPatient = defineCommand({
	aggregate: patientAggregate,
	handler: registerPatientHandler,
});
const recordAllergy = defineCommand({
	aggregate: patientAggregate,
	handler: recordAllergyHandler,
});
const issuePrescription = defineCommand({
	aggregate: patientAggregate,
	handler: issuePrescriptionHandler,
});
const startEncounter = defineCommand({
	aggregate: patientAggregate,
	handler: startEncounterHandler,
});
const closeEncounter = defineCommand({
	aggregate: patientAggregate,
	handler: closeEncounterHandler,
});

// ─── Projection ────────────────────────────────────────────────────────────

type PatientSummary = {
	name: string;
	age: number;
	lastEncounterDate?: Date;
	activePrescriptionsCount: number;
	knownAllergies: string[];
};

const patientSummaryProjection: Projection<PatientSummary, PatientEvent> = {
	initialState: {
		name: "",
		age: 0,
		lastEncounterDate: undefined,
		activePrescriptionsCount: 0,
		knownAllergies: [],
	},
	fold: (summary, event) =>
		matchEvent(event, {
			PatientRegistered: (e) => ({
				name: e.name,
				age: new Date().getFullYear() - e.dateOfBirth.getFullYear(),
				lastEncounterDate: undefined,
				activePrescriptionsCount: 0,
				knownAllergies: [],
			}),
			AllergyRecorded: (e) => ({
				...summary,
				knownAllergies: [...summary.knownAllergies, e.allergen],
			}),
			PrescriptionIssued: (e) => ({
				...summary,
				activePrescriptionsCount:
					summary.activePrescriptionsCount + (e.endDate > new Date() ? 1 : 0),
			}),
			EncounterStarted: (e) => ({
				...summary,
				lastEncounterDate: e.startedAt,
			}),
			EncounterClosed: () => summary,
		}),
};

// ─── Setup helpers ─────────────────────────────────────────────────────────

const DOB = new Date("1985-06-15");

async function registeredPatient(patientId = "p-1") {
	const store = new InMemoryEventStore<PatientEvent>();
	await createAggregate({
		store,
		streamId: patientId,
		events: [],
		idempotencyKey: `open-${patientId}`,
	});
	unwrap(
		await registerPatient.execute({
			store,
			streamId: patientId,
			command: { patientId, name: "Jane Doe", dateOfBirth: DOB },
			idempotencyKey: `register-${patientId}`,
		}),
	);
	return { store, streamId: patientId };
}

async function patientWithPenicillinAllergy(patientId = "p-1") {
	const { store, streamId } = await registeredPatient(patientId);
	unwrap(
		await recordAllergy.execute({
			store,
			streamId,
			command: { allergen: "Penicillin", severity: "Severe" },
			idempotencyKey: "allergy-pen",
		}),
	);
	return { store, streamId };
}

async function patientWithPrescription(patientId = "p-1") {
	const { store, streamId } = await registeredPatient(patientId);
	const startDate = new Date("2024-01-01");
	const endDate = new Date("2099-12-31"); // far future — counts as active
	unwrap(
		await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Ibuprofen",
				dosage: "200mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-001",
		}),
	);
	return { store, streamId };
}

async function patientWithOpenEncounter(patientId = "p-1") {
	const { store, streamId } = await registeredPatient(patientId);
	const startedAt = new Date("2024-06-01T09:00:00Z");
	unwrap(
		await startEncounter.execute({
			store,
			streamId,
			command: { encounterId: "enc-1", reason: "Routine checkup", startedAt },
			idempotencyKey: "enc-1",
		}),
	);
	return { store, streamId };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Patient — registerPatient", () => {
	it("registers a patient and sets their basic info", async () => {
		const store = new InMemoryEventStore<PatientEvent>();
		await createAggregate({
			store,
			streamId: "p-1",
			events: [],
			idempotencyKey: "open",
		});

		const result = await registerPatient.execute({
			store,
			streamId: "p-1",
			command: { patientId: "p-1", name: "Jane Doe", dateOfBirth: DOB },
			idempotencyKey: "register",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.name).toBe("Jane Doe");
		expect(result.value.state.patientId).toBe("p-1");
		expect(result.value.state.allergies).toEqual([]);
		expect(result.value.state.prescriptions).toEqual([]);
		expect(result.value.state.currentEncounter).toBeNull();
		expect(result.value.events[0].type).toBe("PatientRegistered");
	});
});

describe("Patient — recordAllergy", () => {
	it("records a new allergy on the patient", async () => {
		const { store, streamId } = await registeredPatient();

		const result = await recordAllergy.execute({
			store,
			streamId,
			command: { allergen: "Penicillin", severity: "Severe" },
			idempotencyKey: "allergy",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.allergies).toEqual([
			{ allergen: "Penicillin", severity: "Severe" },
		]);
	});

	it("accumulates multiple allergies independently", async () => {
		const { store, streamId } = await patientWithPenicillinAllergy();

		unwrap(
			await recordAllergy.execute({
				store,
				streamId,
				command: { allergen: "Latex", severity: "Mild" },
				idempotencyKey: "allergy-latex",
			}),
		);

		const loaded = unwrap(
			await loadAggregate({ store, streamId, aggregate: patientAggregate }),
		);
		expect(loaded.state.allergies).toHaveLength(2);
		expect(loaded.state.allergies.map((a) => a.allergen)).toEqual([
			"Penicillin",
			"Latex",
		]);
	});
});

describe("Patient — issuePrescription", () => {
	it("issues a prescription for a drug with no allergy conflict", async () => {
		const { store, streamId } = await patientWithPenicillinAllergy();
		const startDate = new Date("2024-01-01");
		const endDate = new Date("2024-01-31");

		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Ibuprofen",
				dosage: "200mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-001",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.prescriptions).toHaveLength(1);
		expect(result.value.state.prescriptions[0].drug).toBe("Ibuprofen");
	});

	it("rejects a prescription when the drug matches a known allergen", async () => {
		const { store, streamId } = await patientWithPenicillinAllergy();
		const startDate = new Date("2024-01-01");
		const endDate = new Date("2024-01-08");

		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Penicillin",
				dosage: "500mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-conflict",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			type: "AllergyConflict",
			drug: "Penicillin",
			allergen: "Penicillin",
		});
	});

	it("rejects a prescription whose end date is before its start date", async () => {
		const { store, streamId } = await registeredPatient();
		const startDate = new Date("2024-01-31");
		const endDate = new Date("2024-01-01"); // before start

		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Ibuprofen",
				dosage: "200mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-bad-dates",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "InvalidPrescriptionDates" });
	});

	it("rejects a prescription whose end date equals its start date", async () => {
		const { store, streamId } = await registeredPatient();
		const date = new Date("2024-01-01");

		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Ibuprofen",
				dosage: "200mg",
				startDate: date,
				endDate: date,
			},
			idempotencyKey: "rx-same-dates",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "InvalidPrescriptionDates" });
	});

	it("rejects a duplicate prescription ID", async () => {
		const { store, streamId } = await patientWithPrescription();
		const startDate = new Date("2024-02-01");
		const endDate = new Date("2024-02-28");

		// RX-001 was already issued in patientWithPrescription()
		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-001",
				drug: "Aspirin",
				dosage: "100mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-duplicate",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "DuplicatePrescriptionId" });
	});

	it("allows a second prescription with a different ID", async () => {
		const { store, streamId } = await patientWithPrescription();
		const startDate = new Date("2024-02-01");
		const endDate = new Date("2024-02-28");

		const result = await issuePrescription.execute({
			store,
			streamId,
			command: {
				prescriptionId: "RX-002",
				drug: "Aspirin",
				dosage: "100mg",
				startDate,
				endDate,
			},
			idempotencyKey: "rx-002",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.prescriptions).toHaveLength(2);
	});
});

describe("Patient — startEncounter", () => {
	it("starts an encounter for a patient with no current encounter", async () => {
		const { store, streamId } = await registeredPatient();
		const startedAt = new Date("2024-06-01T09:00:00Z");

		const result = await startEncounter.execute({
			store,
			streamId,
			command: { encounterId: "enc-1", reason: "Routine checkup", startedAt },
			idempotencyKey: "enc-1",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.currentEncounter?.encounterId).toBe("enc-1");
		expect(result.value.state.currentEncounter?.status).toBe("Open");
		expect(result.value.state.currentEncounter?.reason).toBe("Routine checkup");
		expect(result.value.state.currentEncounter?.startedAt).toEqual(startedAt);
	});

	it("rejects starting an encounter when one is already open", async () => {
		const { store, streamId } = await patientWithOpenEncounter();

		const result = await startEncounter.execute({
			store,
			streamId,
			command: {
				encounterId: "enc-2",
				reason: "Follow-up",
				startedAt: new Date(),
			},
			idempotencyKey: "enc-2",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "EncounterAlreadyOpen" });
	});

	it("allows a new encounter after a previous one is closed", async () => {
		const { store, streamId } = await patientWithOpenEncounter();
		unwrap(
			await closeEncounter.execute({
				store,
				streamId,
				command: {
					notes: "All clear",
					closedAt: new Date("2024-06-01T10:00:00Z"),
				},
				idempotencyKey: "close-1",
			}),
		);

		const result = await startEncounter.execute({
			store,
			streamId,
			command: {
				encounterId: "enc-2",
				reason: "Follow-up",
				startedAt: new Date("2024-07-01T09:00:00Z"),
			},
			idempotencyKey: "enc-2",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.currentEncounter?.encounterId).toBe("enc-2");
		expect(result.value.state.currentEncounter?.status).toBe("Open");
	});
});

describe("Patient — closeEncounter", () => {
	it("closes an open encounter with notes", async () => {
		const { store, streamId } = await patientWithOpenEncounter();
		const closedAt = new Date("2024-06-01T10:30:00Z");

		const result = await closeEncounter.execute({
			store,
			streamId,
			command: { notes: "Patient recovering well", closedAt },
			idempotencyKey: "close-1",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.currentEncounter?.status).toBe("Closed");
		expect(result.value.state.currentEncounter?.notes).toBe(
			"Patient recovering well",
		);
		expect(result.value.state.currentEncounter?.closedAt).toEqual(closedAt);
	});

	it("rejects closing when there is no open encounter", async () => {
		const { store, streamId } = await registeredPatient();

		const result = await closeEncounter.execute({
			store,
			streamId,
			command: { notes: "nothing to close", closedAt: new Date() },
			idempotencyKey: "close-none",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "NoOpenEncounter" });
	});

	it("rejects closing an already-closed encounter", async () => {
		const { store, streamId } = await patientWithOpenEncounter();
		unwrap(
			await closeEncounter.execute({
				store,
				streamId,
				command: { notes: "first close", closedAt: new Date() },
				idempotencyKey: "close-1",
			}),
		);

		const result = await closeEncounter.execute({
			store,
			streamId,
			command: { notes: "second close", closedAt: new Date() },
			idempotencyKey: "close-2",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toEqual({ type: "NoOpenEncounter" });
	});
});

describe("Patient — patientSummaryProjection", () => {
	it("reflects name and age from registration", async () => {
		const { store, streamId } = await registeredPatient();

		const result = await project({
			store,
			streamId,
			projection: patientSummaryProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.name).toBe("Jane Doe");
		// Age derived from DOB (1985) — just verify it's a plausible positive number
		expect(result.value.state.age).toBeGreaterThan(0);
	});

	it("accumulates known allergies", async () => {
		const { store, streamId } = await patientWithPenicillinAllergy();
		unwrap(
			await recordAllergy.execute({
				store,
				streamId,
				command: { allergen: "Latex", severity: "Mild" },
				idempotencyKey: "allergy-latex",
			}),
		);

		const result = await project({
			store,
			streamId,
			projection: patientSummaryProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.knownAllergies).toEqual(["Penicillin", "Latex"]);
	});

	it("counts only active (future-expiring) prescriptions", async () => {
		const { store, streamId } = await registeredPatient();

		// Expired prescription
		unwrap(
			await issuePrescription.execute({
				store,
				streamId,
				command: {
					prescriptionId: "RX-001",
					drug: "Aspirin",
					dosage: "100mg",
					startDate: new Date("2020-01-01"),
					endDate: new Date("2020-01-31"),
				},
				idempotencyKey: "rx-expired",
			}),
		);
		// Active prescription (far future end date)
		unwrap(
			await issuePrescription.execute({
				store,
				streamId,
				command: {
					prescriptionId: "RX-002",
					drug: "Ibuprofen",
					dosage: "200mg",
					startDate: new Date("2024-01-01"),
					endDate: new Date("2099-12-31"),
				},
				idempotencyKey: "rx-active",
			}),
		);

		const result = await project({
			store,
			streamId,
			projection: patientSummaryProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.activePrescriptionsCount).toBe(1);
	});

	it("tracks the last encounter start date", async () => {
		const { store, streamId } = await registeredPatient();
		const firstAt = new Date("2024-01-15T09:00:00Z");
		const secondAt = new Date("2024-03-20T09:00:00Z");

		unwrap(
			await startEncounter.execute({
				store,
				streamId,
				command: {
					encounterId: "enc-1",
					reason: "First visit",
					startedAt: firstAt,
				},
				idempotencyKey: "enc-1",
			}),
		);
		unwrap(
			await closeEncounter.execute({
				store,
				streamId,
				command: {
					notes: "All good",
					closedAt: new Date("2024-01-15T10:00:00Z"),
				},
				idempotencyKey: "close-1",
			}),
		);
		unwrap(
			await startEncounter.execute({
				store,
				streamId,
				command: {
					encounterId: "enc-2",
					reason: "Follow-up",
					startedAt: secondAt,
				},
				idempotencyKey: "enc-2",
			}),
		);

		const result = await project({
			store,
			streamId,
			projection: patientSummaryProjection,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.lastEncounterDate).toEqual(secondAt);
	});
});

describe("Patient — aggregate state replay", () => {
	it("rebuilds the correct state from a full sequence of events", async () => {
		const { store, streamId } = await patientWithPenicillinAllergy();
		const start = new Date("2024-06-01T09:00:00Z");
		const close = new Date("2024-06-01T10:00:00Z");

		unwrap(
			await issuePrescription.execute({
				store,
				streamId,
				command: {
					prescriptionId: "RX-001",
					drug: "Ibuprofen",
					dosage: "200mg",
					startDate: new Date("2024-01-01"),
					endDate: new Date("2024-01-31"),
				},
				idempotencyKey: "rx-001",
			}),
		);
		unwrap(
			await startEncounter.execute({
				store,
				streamId,
				command: { encounterId: "enc-1", reason: "Cough", startedAt: start },
				idempotencyKey: "enc-1",
			}),
		);
		unwrap(
			await closeEncounter.execute({
				store,
				streamId,
				command: { notes: "Recovering well", closedAt: close },
				idempotencyKey: "close-1",
			}),
		);

		const loaded = unwrap(
			await loadAggregate({ store, streamId, aggregate: patientAggregate }),
		);

		expect(loaded.state.name).toBe("Jane Doe");
		expect(loaded.state.allergies).toHaveLength(1);
		expect(loaded.state.prescriptions).toHaveLength(1);
		expect(loaded.state.currentEncounter?.status).toBe("Closed");
		expect(loaded.state.currentEncounter?.notes).toBe("Recovering well");
	});
});
