// First-run setup: creates the clinic and its first practice manager. Runs before any clinic or staff
// profile exists, so it cannot use the normal caller resolution.
//
// SECURITY: only an administrator of the Base44 app (its owner) may run it, and only while no clinic with
// this key exists. Two simultaneous runs are resolved by storage order, so exactly one clinic survives.

import { buildAuditEvent } from '../core/audit.ts';
import { AppError } from './errors.ts';
import type { AuditSink, StaffProfileRecord } from './ports.ts';

export interface ClinicRow {
  id: string;
  slug: string;
  status: string;
  /** Storage creation time, used to settle simultaneous runs. */
  createdAtMs: number;
}

export interface ClinicRegistry {
  findBySlug(slug: string): Promise<ClinicRow[]>;
  create(input: { name: string; slug: string; timeZone: string }): Promise<ClinicRow>;
  suspend(id: string): Promise<void>;
  createStaffProfile(clinicId: string, record: StaffProfileRecord): Promise<void>;
}

export interface BootstrapCaller {
  email: string;
  displayName: string;
  /** True only for an administrator of the Base44 app (its built-in role, not a field users can edit). */
  isAppAdmin: boolean;
}

const SLUG = /^[a-z0-9-]{2,32}$/;

export async function bootstrapClinic(
  caller: BootstrapCaller,
  deps: { registry: ClinicRegistry; audit: AuditSink; clock: () => number; clinicKey: string },
  input: { clinicName?: unknown },
): Promise<{ clinicId: string }> {
  if (!caller.isAppAdmin) throw new AppError('FORBIDDEN', 'Only the owner of the AuraNoteTaker app in Base44 can set it up.');
  if (!SLUG.test(deps.clinicKey)) throw new AppError('INTERNAL', 'AuraNoteTaker is not fully configured. Please tell the practice manager.');
  const raw = typeof input.clinicName === 'string' ? input.clinicName.trim().replace(/\s+/g, ' ') : '';
  // eslint-disable-next-line no-control-regex
  if (raw.length < 2 || raw.length > 80 || /[\u0000-\u001f\u007f]/.test(raw)) throw new AppError('VALIDATION', 'Enter the clinic name.');

  if ((await deps.registry.findBySlug(deps.clinicKey)).length > 0) {
    throw new AppError('ALREADY_SET_UP', 'AuraNoteTaker is already set up. Ask the practice manager for access.');
  }
  const mine = await deps.registry.create({ name: raw, slug: deps.clinicKey, timeZone: 'Europe/London' });
  // Another run may have created one at the same moment: the earliest stored wins, the rest are suspended.
  const all = await deps.registry.findBySlug(deps.clinicKey);
  const first = [...all].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1))[0];
  if (first && first.id !== mine.id) {
    await deps.registry.suspend(mine.id);
    throw new AppError('ALREADY_SET_UP', 'AuraNoteTaker is already set up. Ask the practice manager for access.');
  }
  await deps.registry.createStaffProfile(mine.id, {
    email: caller.email.toLowerCase(),
    displayName: caller.displayName,
    roles: ['CLINIC_ADMIN'],
    clinicianId: null,
    active: true,
  });
  await deps.audit.append(
    buildAuditEvent({
      clinicId: mine.id,
      occurredAtMs: deps.clock(),
      actorEmail: caller.email.toLowerCase(),
      actorRoles: ['APP_ADMIN'],
      action: 'CONFIG_CHANGED',
      details: { entity: 'CLINIC', change: 'BOOTSTRAPPED', count: 1 },
    }),
  );
  return { clinicId: mine.id };
}
