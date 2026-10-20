// GENERATED from lib/dentally/service.ts by scripts/sync-base44-shared.mjs. Do not edit; edit lib/ instead.
// Live Dentally service: wraps the read-only client and validates every record.

import type { DiaryAppointment } from '../core/appointments.ts';
import type { DentallyClient } from './client.ts';
import { parseAppointment, parsePatient, parsePractitioner, parseRoom, toId } from './parse.ts';
import type {
  DentallyCapabilities,
  DentallyReadService,
  DiaryResult,
  PatientSummary,
  PractitionerSummary,
  RoomListReport,
  RoomSummary,
  UnsupportedResult,
} from './types.ts';

/**
 * What the public Dentally API supports today (October 2026). Clinical notes cannot be
 * read or written; see docs/dentally-integration.md. Flip these only when Dentally ships
 * the endpoints and the change has been through escalation (spec section 25).
 */
export const DENTALLY_CAPABILITIES: Readonly<DentallyCapabilities> = Object.freeze({
  readDiary: true,
  readPatients: true,
  readClinicalHistory: false,
  readClinicalNotes: false,
  writeClinicalNotes: false,
});

export function unsupported(detail: string): UnsupportedResult {
  return { supported: false, reason: 'NOT_AVAILABLE_IN_DENTALLY_API', detail };
}

export const UNSUPPORTED_DETAIL = {
  clinicalHistory: 'Dentally does not expose clinical history or clinical notes through its public API.',
  notesRead: 'Dentally does not expose clinical notes through its public API.',
  notesWrite:
    'Dentally does not allow clinical notes to be created through its public API. Approved notes are exported for entry in Dentally instead. Appointment notes are never used as a substitute.',
} as const;

function parseDiary(raw: unknown[]): DiaryResult {
  const appointments: DiaryAppointment[] = [];
  let rejectedCount = 0;
  for (const item of raw) {
    const r = parseAppointment(item);
    if (r.ok) appointments.push(r.value);
    else rejectedCount += 1;
  }
  return { appointments, rejectedCount };
}

export function createLiveDentallyService(client: DentallyClient): DentallyReadService {
  return {
    mode: 'live',
    capabilities: () => ({ ...DENTALLY_CAPABILITIES }),

    async getTodaysAppointments({ date, siteId }) {
      return parseDiary(await client.listAppointments({ on: date, siteId }));
    },

    async getClinicianAppointments({ date, practitionerId, siteId }) {
      return parseDiary(await client.listAppointments({ on: date, practitionerId, siteId }));
    },

    async getAppointment(appointmentId) {
      const raw = await client.getAppointment(appointmentId);
      if (raw === null) return null;
      const r = parseAppointment(raw);
      return r.ok ? r.value : null;
    },

    async getPatient(patientId): Promise<PatientSummary | null> {
      const raw = await client.getPatient(patientId);
      if (raw === null) return null;
      const r = parsePatient(raw);
      return r.ok ? r.value : null;
    },

    async listPractitioners(): Promise<PractitionerSummary[]> {
      return (await client.listPractitioners()).map(parsePractitioner).flatMap((r) => (r.ok ? [r.value] : []));
    },

    async listRooms(): Promise<RoomSummary[]> {
      return (await this.listRoomsWithReport()).rooms;
    },

    async listRoomsWithReport(): Promise<RoomListReport> {
      let raw = await client.listRooms();
      let bySite = false;
      if (raw.length === 0) {
        // Some accounts only list rooms per site: ask each site in turn.
        bySite = true;
        for (const site of await client.listSites()) {
          const siteId = site && typeof site === 'object' ? toId((site as { id?: unknown }).id) : null;
          if (siteId) raw = raw.concat(await client.listRooms(siteId));
        }
      }
      const rooms: RoomSummary[] = [];
      const rejected: Record<string, number> = {};
      const seen = new Set<string>();
      for (const item of raw) {
        const r = parseRoom(item);
        if (!r.ok) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
        else if (!seen.has(r.value.roomId)) {
          seen.add(r.value.roomId);
          rooms.push(r.value);
        }
      }
      const first = raw[0];
      const fieldNames = first && typeof first === 'object' ? Object.keys(first).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 30) : [];
      return { rooms, returned: raw.length, rejected, bySite, fieldNames };
    },

    async ping() {
      return { latencyMs: await client.ping() };
    },

    async getPatientClinicalHistory() {
      return unsupported(UNSUPPORTED_DETAIL.clinicalHistory);
    },

    async getPatientNotes() {
      return unsupported(UNSUPPORTED_DETAIL.notesRead);
    },

    async createClinicalNote() {
      return unsupported(UNSUPPORTED_DETAIL.notesWrite);
    },
  };
}
