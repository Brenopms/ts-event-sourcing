// healthcare.ts
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
	type Result,
} from "../src";

// ------------------------------------------------------------------
// 1. Domain Events
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 2. Aggregate State
// ------------------------------------------------------------------
type EncounterStatus = "Open" | "Closed";

type EncounterInfo = {
	encounterId: string;
	reason: string;
	startedAt: Date;
	status: EncounterStatus;
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

// ------------------------------------------------------------------
// 3. Commands
// ------------------------------------------------------------------
type RegisterPatientCommand = {
	patientId: string;
	name: string;
	dateOfBirth: Date;
};

type RecordAllergyCommand = {
	allergen: string;
	severity: "Mild" | "Moderate" | "Severe";
};

type IssuePrescriptionCommand = {
	prescriptionId: string;
	drug: string;
	dosage: string;
	startDate: Date;
	endDate: Date;
};

type StartEncounterCommand = {
	encounterId: string;
	reason: string;
	startAt: Date;
};

type CloseEncounterCommand = {
	notes: string;
	closedAt: Date;
};

// Domain errors
type PatientError =
	| { type: "PatientAlreadyRegistered" }
	| { type: "PatientNotFound" }
	| { type: "EncounterAlreadyOpen" }
	| { type: "NoOpenEncounter" }
	| { type: "AllergyConflict"; drug: string; allergen: string }
	| { type: "InvalidPrescriptionDates" }
	| { type: "DuplicatePrescriptionId" };

// ------------------------------------------------------------------
// 5. Aggregate Reducer (exhaustive using matchEvent)
// ------------------------------------------------------------------
const patientAggregate: AggregateDefinition<PatientState, PatientEvent> = {
	initialState: {
		patientId: "",
		name: "",
		dateOfBirth: new Date(),
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

// ------------------------------------------------------------------
// 6. Command Handlers
// ------------------------------------------------------------------
const registerPatientHandler: CommandHandler<
	PatientState,
	RegisterPatientCommand,
	PatientEvent,
	PatientError
> = ({ command }) => {
	console.log(
		`   → Handler: Registering patient ${command.patientId} - ${command.name}`,
	);
	// No domain error for registration (we expect stream to be empty; core will handle existence)
	return Ok([{ type: "PatientRegistered", ...command }]);
};

const recordAllergyHandler: CommandHandler<
	PatientState,
	RecordAllergyCommand,
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	console.log(
		`   → Handler: Recording allergy ${command.allergen} for patient ${state.patientId}`,
	);
	return Ok([
		{
			type: "AllergyRecorded",
			patientId: state.patientId,
			allergen: command.allergen,
			severity: command.severity,
		},
	]);
};

const issuePrescriptionHandler: CommandHandler<
	PatientState,
	IssuePrescriptionCommand,
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	console.log(
		`   → Handler: Issuing prescription ${command.prescriptionId} (${command.drug})`,
	);

	// Check for duplicate prescription ID
	if (
		state.prescriptions.some((p) => p.prescriptionId === command.prescriptionId)
	) {
		return Err({ type: "DuplicatePrescriptionId" });
	}

	// Check for allergies
	const allergy = state.allergies.find((a) =>
		command.drug.toLowerCase().includes(a.allergen.toLowerCase()),
	);

	if (allergy) {
		console.log(
			`   → ❌ Allergy conflict: ${command.drug} contains ${allergy.allergen}`,
		);
		return Err({
			type: "AllergyConflict",
			drug: command.drug,
			allergen: allergy.allergen,
		});
	}

	// Date validation
	if (command.endDate <= command.startDate) {
		return Err({ type: "InvalidPrescriptionDates" });
	}

	return Ok([
		{
			type: "PrescriptionIssued",
			patientId: state.patientId,
			prescriptionId: command.prescriptionId,
			drug: command.drug,
			dosage: command.dosage,
			startDate: command.startDate,
			endDate: command.endDate,
		},
	]);
};

const startEncounterHandler: CommandHandler<
	PatientState,
	StartEncounterCommand,
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	console.log(
		`   → Handler: Starting encounter ${command.encounterId} for patient ${state.patientId}`,
	);
	if (state.currentEncounter && state.currentEncounter.status === "Open") {
		return Err({ type: "EncounterAlreadyOpen" });
	}
	return Ok([
		{
			type: "EncounterStarted",
			patientId: state.patientId,
			encounterId: command.encounterId,
			reason: command.reason,
			startedAt: command.startAt,
		},
	]);
};

const closeEncounterHandler: CommandHandler<
	PatientState,
	CloseEncounterCommand,
	PatientEvent,
	PatientError
> = ({ state, command }) => {
	console.log(`   → Handler: Closing encounter for patient ${state.patientId}`);
	if (!state.currentEncounter || state.currentEncounter.status !== "Open") {
		return Err({ type: "NoOpenEncounter" });
	}
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

// ------------------------------------------------------------------
// 7. Define commands using defineCommand
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// 8. Projection: Patient Summary (read model)
// ------------------------------------------------------------------
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
			PrescriptionIssued: (e) => {
				// only count if endDate is in future
				const isActive = e.endDate > new Date();
				return {
					...summary,
					activePrescriptionsCount:
						summary.activePrescriptionsCount + (isActive ? 1 : 0),
				};
			},
			EncounterStarted: (e) => ({
				...summary,
				lastEncounterDate: e.startedAt,
			}),
			EncounterClosed: () => summary, // no change
		}),
};

// ------------------------------------------------------------------
// 9. Helper logging
// ------------------------------------------------------------------
function logResult<T, E>(label: string, result: Result<T, E>): T | null {
	if (result.ok) {
		console.log(`✅ ${label}:`, JSON.stringify(result.value, null, 2));
		return result.value;
	} else {
		console.error(`❌ ${label}:`, result.error);
		return null;
	}
}

// ------------------------------------------------------------------
// 10. Main execution
// ------------------------------------------------------------------
async function main() {
	console.log("\n=== Healthcare Patient Management (Event Sourced) ===\n");

	const store = new InMemoryEventStore<PatientEvent>();
	const patientId = "patient-001";

	// 1. Create aggregate stream
	console.log("1. Creating patient stream...");
	await createAggregate({
		store,
		streamId: patientId,
		events: [],
		idempotencyKey: "create-patient",
	});
	console.log();

	// 2. Register patient
	console.log("2. Registering patient...");
	const registerResult = await registerPatient.execute({
		store,
		streamId: patientId,
		command: {
			patientId,
			name: "Jane Doe",
			dateOfBirth: new Date("1985-06-15"),
		},
		idempotencyKey: "register",
	});
	const registered = logResult("Register patient", registerResult);
	if (!registered) return;
	console.log();

	// 3. Record allergy
	console.log("3. Recording allergy (Penicillin)...");
	const allergyResult = await recordAllergy.execute({
		store,
		streamId: patientId,
		command: { allergen: "Penicillin", severity: "Severe" },
		idempotencyKey: "record-allergy",
	});
	logResult("Record allergy", allergyResult);
	const loadResult2 = await loadAggregate({
		store,
		streamId: patientId,
		aggregate: patientAggregate,
	});
	logResult("record aggregate", loadResult2);
	console.log();

	// 4. Issue prescription (safe drug)
	console.log(
		"4. Issuing prescription (Penicilin) - should fail due to allergy",
	);
	const prescriptionFail = await issuePrescription.execute({
		store,
		streamId: patientId,
		command: {
			prescriptionId: "RX-001",
			drug: "Penicillin",
			dosage: "500mg daily",
			startDate: new Date(),
			endDate: new Date(Date.now() + 7 * 86400000), // 7 days
		},
		idempotencyKey: "prescribe-fail",
	});
	logResult("Prescription with allergy conflict", prescriptionFail);
	console.log();

	// 5. Issue safe prescription (different drug)
	console.log("5. Issuing safe prescription (Ibuprofen)...");
	const prescriptionOk = await issuePrescription.execute({
		store,
		streamId: patientId,
		command: {
			prescriptionId: "RX-002",
			drug: "Ibuprofen",
			dosage: "200mg as needed",
			startDate: new Date(),
			endDate: new Date(Date.now() + 30 * 86400000), // 30 days
		},
		idempotencyKey: "prescribe-safe",
	});
	logResult("Safe prescription", prescriptionOk);
	console.log();

	// 6. Start encounter
	console.log("6. Starting encounter (reason: cough and fever)...");
	const startEnc = await startEncounter.execute({
		store,
		streamId: patientId,
		command: {
			encounterId: "enc-001",
			reason: "Cough and fever",
			startAt: new Date(),
		},
		idempotencyKey: "start-enc",
	});
	logResult("Start encounter", startEnc);
	console.log();

	// 7. Try to start another encounter while one is open (should fail)
	console.log("7. Attempting to start a second encounter while one is open...");
	const secondEnc = await startEncounter.execute({
		store,
		streamId: patientId,
		command: {
			encounterId: "enc-002",
			reason: "Routine checkup",
			startAt: new Date(),
		},
		idempotencyKey: "start-second",
	});
	logResult("Second encounter (should fail)", secondEnc);
	console.log();

	// 8. Close encounter
	console.log("8. Closing encounter with notes...");
	const closeEnc = await closeEncounter.execute({
		store,
		streamId: patientId,
		command: {
			notes: "Prescribed Ibuprofen, advised rest",
			closedAt: new Date(),
		},
		idempotencyKey: "close-enc",
	});
	logResult("Close encounter", closeEnc);
	console.log();

	// 9. Project patient summary
	console.log("9. Projecting patient summary (read model)...");
	const summaryResult = await project({
		store,
		streamId: patientId,
		projection: patientSummaryProjection,
	});
	const summary = logResult("Patient summary", summaryResult);
	if (summary) {
		console.log("   → Summary:", {
			name: summary.state.name,
			age: summary.state.age,
			allergies: summary.state.knownAllergies,
			activePrescriptions: summary.state.activePrescriptionsCount,
			lastEncounter: summary.state.lastEncounterDate,
		});
	}
	console.log();

	// 10. Load final aggregate state
	console.log("10. Loading final aggregate state...");
	const loadResult = await loadAggregate({
		store,
		streamId: patientId,
		aggregate: patientAggregate,
	});
	const finalState = logResult("Final aggregate", loadResult);
	if (finalState) {
		console.log(
			`   → Patient: ${finalState.state.name}, ${finalState.state.allergies.length} allergies, ${finalState.state.prescriptions.length} prescriptions`,
		);
		console.log(
			`   → Current encounter: ${finalState.state.currentEncounter?.status || "none"}`,
		);
	}

	console.log("\n=== Healthcare example completed ===");
}

main().catch(console.error);
