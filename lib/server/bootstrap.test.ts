import { describe, expect, it } from 'vitest';
import type { ClinicRegistry, ClinicRow } from './bootstrap.ts';
import { bootstrapClinic } from './bootstrap.ts';
import { AppError } from './errors.ts';
import { InMemoryAuditSink } from './memory.ts';
import type { StaffProfileRecord } from './ports.ts';

class MemoryRegistry implements ClinicRegistry {
  clinics: ClinicRow[] = [];
  staff: Array<StaffProfileRecord & { clinicId: string }> = [];
  #n = 0;
  async findBySlug(slug: string) {
    return this.clinics.filter((c) => c.slug === slug).map((c) => ({ ...c }));
  }
  async create(input: { name: string; slug: string; timeZone: string }) {
    const row = { id: `clinic-${++this.#n}`, slug: input.slug, status: 'ACTIVE', createdAtMs: this.#n };
    this.clinics.push(row);
    return { ...row };
  }
  async suspend(id: string) {
    this.clinics.find((c) => c.id === id)!.status = 'SUSPENDED';
  }
  async createStaffProfile(clinicId: string, record: StaffProfileRecord) {
    this.staff.push({ ...record, clinicId });
  }
}

const owner = { email: 'Hisham@Aura.test', displayName: 'Hisham', isAppAdmin: true };

function setup() {
  const registry = new MemoryRegistry();
  const audit = new InMemoryAuditSink();
  return { registry, audit, deps: { registry, audit, clock: () => 1_000, clinicKey: 'aura' } };
}

describe('bootstrapClinic', () => {
  it('creates the clinic and makes the app owner its first practice manager, with an audit record', async () => {
    const { registry, audit, deps } = setup();
    const { clinicId } = await bootstrapClinic(owner, deps, { clinicName: '  Aura Dental Clinic ' });
    expect(registry.clinics).toEqual([expect.objectContaining({ id: clinicId, slug: 'aura', status: 'ACTIVE' })]);
    expect(registry.staff).toEqual([{ clinicId, email: 'hisham@aura.test', displayName: 'Hisham', roles: ['CLINIC_ADMIN'], clinicianId: null, active: true }]);
    expect(audit.events[0]).toMatchObject({ clinicId, action: 'CONFIG_CHANGED', details: { entity: 'CLINIC', change: 'BOOTSTRAPPED' } });
  });

  it('refuses anyone who is not an administrator of the Base44 app', async () => {
    const { registry, deps } = setup();
    await expect(bootstrapClinic({ ...owner, isAppAdmin: false }, deps, { clinicName: 'Aura' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(registry.clinics).toHaveLength(0);
  });

  it('runs only once', async () => {
    const { deps } = setup();
    await bootstrapClinic(owner, deps, { clinicName: 'Aura Dental Clinic' });
    await expect(bootstrapClinic(owner, deps, { clinicName: 'Aura Dental Clinic' })).rejects.toMatchObject({ code: 'ALREADY_SET_UP' });
  });

  it('leaves exactly one clinic when two runs happen at the same moment', async () => {
    const { registry, deps } = setup();
    const results = await Promise.allSettled([
      bootstrapClinic(owner, deps, { clinicName: 'Aura Dental Clinic' }),
      bootstrapClinic(owner, deps, { clinicName: 'Aura Dental Clinic' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(registry.clinics.filter((c) => c.status === 'ACTIVE')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AppError);
  });

  it('needs a clinic name', async () => {
    const { deps } = setup();
    await expect(bootstrapClinic(owner, deps, { clinicName: ' ' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
