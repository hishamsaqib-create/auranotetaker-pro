// Fictional Dentally service for demo mode and tests.
//
// Every name, date of birth and identifier here is invented. IDs carry a DEMO- prefix.
// The diary is anchored to the time the service was created, so the "current" appointment
// is current whenever the demo is opened, and time then moves on naturally.

import type { AppointmentState, DiaryAppointment } from '../core/appointments.ts';
import { MINUTE_MS } from '../core/time.ts';
import { DentallyError } from './client.ts';
import { DENTALLY_CAPABILITIES, UNSUPPORTED_DETAIL, unsupported } from './service.ts';
import type { DentallyReadService, DiaryResult, PatientSummary, PractitionerSummary, RoomSummary } from './types.ts';

export type DemoScenario = 'normal' | 'double-booked' | 'overrun' | 'between' | 'taken-early' | 'dentally-offline';

export const DEMO_SCENARIOS: ReadonlyArray<{ id: DemoScenario; label: string }> = [
  { id: 'normal', label: 'Normal: patient in surgery now' },
  { id: 'double-booked', label: 'Double booking' },
  { id: 'overrun', label: 'Previous appointment overrunning' },
  { id: 'between', label: 'Between appointments' },
  { id: 'taken-early', label: 'Next patient taken in early' },
  { id: 'dentally-offline', label: 'Dentally unavailable' },
];

export const DEMO_PRACTITIONERS: readonly PractitionerSummary[] = [
  { practitionerId: 'DEMO-PR1', userId: 'DEMO-U1', displayName: 'Dr Sarah Lin', active: true },
  { practitionerId: 'DEMO-PR2', userId: 'DEMO-U2', displayName: 'Dr James Okafor', active: true },
  { practitionerId: 'DEMO-PR3', userId: 'DEMO-U3', displayName: 'Emma Reid', active: true },
];

export const DEMO_ROOMS: readonly RoomSummary[] = [
  { roomId: 'DEMO-R1', name: 'Surgery 1', siteId: 'DEMO-S1' },
  { roomId: 'DEMO-R2', name: 'Surgery 2', siteId: 'DEMO-S1' },
  { roomId: 'DEMO-R3', name: 'Surgery 3', siteId: 'DEMO-S1' },
];

const DEMO_PATIENTS: Readonly<Record<string, Omit<PatientSummary, 'patientId'>>> = {
  'DEMO-P1001': { displayName: 'Oliver Bennett', dateOfBirth: '1986-03-12' },
  'DEMO-P1002': { displayName: 'Amara Nwosu', dateOfBirth: '1994-11-02' },
  'DEMO-P1003': { displayName: 'Harriet Lowe', dateOfBirth: '1979-06-23' },
  'DEMO-P1004': { displayName: 'Daniel Marsh', dateOfBirth: '1962-01-30' },
  'DEMO-P1005': { displayName: 'Grace Whitfield', dateOfBirth: '2001-09-14' },
  'DEMO-P1006': { displayName: 'Ewan Doyle', dateOfBirth: '1990-04-05' },
  'DEMO-P1007': { displayName: 'Lena Fischer', dateOfBirth: '1983-12-19' },
  'DEMO-P1008': { displayName: 'Marcus Hale', dateOfBirth: '1971-07-08' },
  'DEMO-P1009': { displayName: 'Priya Raman', dateOfBirth: '1997-02-27' },
  'DEMO-P1010': { displayName: 'Tom Ashworth', dateOfBirth: '1958-10-11' },
  'DEMO-P1011': { displayName: 'Isla Brennan', dateOfBirth: '2008-05-16' },
  'DEMO-P1012': { displayName: 'Yusuf Karim', dateOfBirth: '1988-08-21' },
  'DEMO-P1013': { displayName: 'Nora Quinn', dateOfBirth: '1966-03-03' },
};

interface Slot {
  id: string;
  practitionerId: string;
  roomId: string;
  patientId: string | null;
  /** Minutes from the anchor. */
  start: number;
  minutes: number;
  state: AppointmentState;
  reason: string;
}

function baseSchedule(): Slot[] {
  return [
    // Dr Sarah Lin, Surgery 1
    { id: 'DEMO-A01', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1005', start: -130, minutes: 30, state: 'Completed', reason: 'Routine Exam' },
    { id: 'DEMO-A02', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1006', start: -95, minutes: 40, state: 'Completed', reason: 'Composite Restoration' },
    { id: 'DEMO-A03', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1007', start: -50, minutes: 30, state: 'Completed', reason: 'Review' },
    { id: 'DEMO-A04', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1001', start: -15, minutes: 45, state: 'In surgery', reason: 'Halo Veneer Fit' },
    { id: 'DEMO-A05', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1002', start: 30, minutes: 30, state: 'Arrived', reason: 'Composite Bonding' },
    { id: 'DEMO-A06', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1003', start: 60, minutes: 30, state: 'Confirmed', reason: 'Clear Aligner Review' },
    { id: 'DEMO-A07', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: null, start: 90, minutes: 30, state: 'Confirmed', reason: 'Lab call' },
    { id: 'DEMO-A08', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1008', start: 120, minutes: 30, state: 'Cancelled', reason: 'Routine Exam' },
    { id: 'DEMO-A09', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1004', start: 150, minutes: 45, state: 'Pending', reason: 'Implant Consultation' },
    // Dr James Okafor, Surgery 2
    { id: 'DEMO-B01', practitionerId: 'DEMO-PR2', roomId: 'DEMO-R2', patientId: 'DEMO-P1010', start: -40, minutes: 60, state: 'In surgery', reason: 'Crown Preparation' },
    { id: 'DEMO-B02', practitionerId: 'DEMO-PR2', roomId: 'DEMO-R2', patientId: 'DEMO-P1011', start: 20, minutes: 30, state: 'Confirmed', reason: 'Emergency' },
    // Emma Reid, Surgery 3
    { id: 'DEMO-C01', practitionerId: 'DEMO-PR3', roomId: 'DEMO-R3', patientId: 'DEMO-P1012', start: -20, minutes: 40, state: 'In surgery', reason: 'Hygiene' },
    { id: 'DEMO-C02', practitionerId: 'DEMO-PR3', roomId: 'DEMO-R3', patientId: 'DEMO-P1013', start: 20, minutes: 40, state: 'Confirmed', reason: 'Hygiene' },
  ];
}

function applyScenario(slots: Slot[], scenario: DemoScenario): Slot[] {
  const byId = (id: string) => slots.find((s) => s.id === id)!;
  switch (scenario) {
    case 'double-booked':
      byId('DEMO-A04').state = 'Arrived';
      slots.push({ id: 'DEMO-A04B', practitionerId: 'DEMO-PR1', roomId: 'DEMO-R1', patientId: 'DEMO-P1009', start: -15, minutes: 45, state: 'Arrived', reason: 'Emergency' });
      break;
    case 'overrun':
      Object.assign(byId('DEMO-A03'), { start: -55, minutes: 45, state: 'In surgery', reason: 'Composite Bonding' });
      Object.assign(byId('DEMO-A04'), { start: -10, state: 'Arrived' });
      break;
    case 'between':
      Object.assign(byId('DEMO-A04'), { start: 18, minutes: 12, state: 'Confirmed', reason: 'Review' });
      break;
    case 'taken-early':
      Object.assign(byId('DEMO-A04'), { start: 8, minutes: 20, state: 'In surgery' });
      break;
    default:
      break;
  }
  return slots;
}

export interface MockDentallyOptions {
  clock: () => number;
  scenario?: DemoScenario;
  /** Fixed anchor for the fictional day. Defaults to the creation time rounded down to 5 minutes. */
  anchorMs?: number;
}

export class MockDentallyService implements DentallyReadService {
  readonly mode = 'mock' as const;
  readonly #clock: () => number;
  readonly #anchor: number;
  #scenario: DemoScenario;

  constructor(opts: MockDentallyOptions) {
    this.#clock = opts.clock;
    this.#scenario = opts.scenario ?? 'normal';
    this.#anchor = opts.anchorMs ?? Math.floor(opts.clock() / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
  }

  get scenario(): DemoScenario {
    return this.#scenario;
  }

  setScenario(scenario: DemoScenario): void {
    this.#scenario = scenario;
  }

  capabilities() {
    return { ...DENTALLY_CAPABILITIES };
  }

  #checkOnline(): void {
    if (this.#scenario === 'dentally-offline') throw new DentallyError('UNAVAILABLE', 'Could not reach Dentally (demo scenario)');
  }

  #diary(): DiaryAppointment[] {
    return applyScenario(baseSchedule(), this.#scenario).map((s) => {
      const startMs = this.#anchor + s.start * MINUTE_MS;
      const finishMs = startMs + s.minutes * MINUTE_MS;
      return {
        appointmentId: s.id,
        patientId: s.patientId,
        patientName: s.patientId ? (DEMO_PATIENTS[s.patientId]?.displayName ?? null) : null,
        practitionerId: s.practitionerId,
        roomId: s.roomId,
        startMs,
        finishMs,
        state: s.state,
        rawState: null,
        reason: s.reason,
        inSurgeryAtMs: s.state === 'In surgery' ? Math.min(startMs, this.#clock()) : null,
        arrivedAtMs: s.state === 'Arrived' || s.state === 'In surgery' ? startMs - 5 * MINUTE_MS : null,
        completedAtMs: s.state === 'Completed' ? finishMs : null,
      };
    });
  }

  async getTodaysAppointments(): Promise<DiaryResult> {
    this.#checkOnline();
    return { appointments: this.#diary(), rejectedCount: 0 };
  }

  async getClinicianAppointments({ practitionerId }: { practitionerId: string }): Promise<DiaryResult> {
    this.#checkOnline();
    return { appointments: this.#diary().filter((a) => a.practitionerId === practitionerId), rejectedCount: 0 };
  }

  async getAppointment(appointmentId: string): Promise<DiaryAppointment | null> {
    this.#checkOnline();
    return this.#diary().find((a) => a.appointmentId === appointmentId) ?? null;
  }

  async getPatient(patientId: string): Promise<PatientSummary | null> {
    this.#checkOnline();
    const p = DEMO_PATIENTS[patientId];
    return p ? { patientId, ...p } : null;
  }

  async listPractitioners(): Promise<PractitionerSummary[]> {
    this.#checkOnline();
    return DEMO_PRACTITIONERS.map((p) => ({ ...p }));
  }

  async listRooms(): Promise<RoomSummary[]> {
    this.#checkOnline();
    return DEMO_ROOMS.map((r) => ({ ...r }));
  }

  async ping() {
    this.#checkOnline();
    return { latencyMs: 12 };
  }

  async getPatientClinicalHistory() {
    return unsupported(UNSUPPORTED_DETAIL.clinicalHistory);
  }

  async getPatientNotes() {
    return unsupported(UNSUPPORTED_DETAIL.notesRead);
  }

  async createClinicalNote() {
    return unsupported(UNSUPPORTED_DETAIL.notesWrite);
  }
}
