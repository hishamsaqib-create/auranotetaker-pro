import { useCallback, useEffect, useState } from 'react';
import type { ClinicSetupResponse } from '../../lib/server/handlers.ts';
import type { AppBackend, StaffProfileInput } from '../backend/types.ts';
import { Notice } from './Notice.tsx';

type ClinicianType = 'DENTIST' | 'THERAPIST' | 'HYGIENIST' | 'OTHER';

const TYPE_LABELS: Record<ClinicianType, string> = { DENTIST: 'Dentist', THERAPIST: 'Therapist', HYGIENIST: 'Hygienist', OTHER: 'Other' };
const ROLE_LABELS: Record<string, string> = {
  CLINIC_ADMIN: 'Practice manager (setup)',
  DENTIST: 'Dentist',
  THERAPIST: 'Therapist',
  HYGIENIST: 'Hygienist',
  NURSE: 'Nurse',
  AUDITOR: 'Auditor',
};

const emptyProfile: StaffProfileInput = { email: '', displayName: '', roles: [], clinicianId: null, active: true };

/**
 * Practice manager's setup: which Dentally clinicians and surgeries AuraNoteTaker uses, and who can sign in
 * with which roles. Reads practitioner and room lists from Dentally, never patients.
 */
export function AdminScreen({
  backend,
  onClose,
  hasClinicalRole = true,
}: {
  backend: AppBackend;
  onClose?: () => void | Promise<void>;
  /** False for a practice manager with no clinical role: leaving needs a clinical role first. */
  hasClinicalRole?: boolean;
}) {
  const [setup, setSetup] = useState<ClinicSetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clinicians, setClinicians] = useState<Record<string, { include: boolean; type: ClinicianType }>>({});
  const [rooms, setRooms] = useState<Record<string, boolean>>({});
  /** Surgeries named here (not Dentally rooms), keyed by their saved ID. */
  const [named, setNamed] = useState<Record<string, boolean>>({});
  const [newSurgery, setNewSurgery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [profile, setProfile] = useState<StaffProfileInput>(emptyProfile);

  const apply = useCallback((s: ClinicSetupResponse) => {
    setSetup(s);
    setClinicians(
      Object.fromEntries(
        (s.dentally?.practitioners ?? []).map((p) => {
          const configured = s.clinicians.find((c) => c.practitionerId === p.practitionerId);
          return [p.practitionerId, { include: configured?.active ?? false, type: configured?.clinicianType ?? 'DENTIST' }];
        }),
      ),
    );
    setRooms(
      Object.fromEntries((s.dentally?.rooms ?? []).map((r) => [r.roomId, s.surgeries.find((x) => x.roomId === r.roomId)?.active ?? false])),
    );
    setNamed(Object.fromEntries(s.surgeries.filter((x) => x.roomId === null).map((x) => [x.surgeryId, x.active])));
  }, []);

  useEffect(() => {
    backend
      .getClinicSetup()
      .then(apply)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the setup.'));
  }, [backend, apply]);

  async function save(label: string, fn: () => Promise<ClinicSetupResponse>, after?: () => void) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      apply(await fn());
      setSaved(label);
      after?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!setup) {
    return (
      <main className="setup">
        {error ? <Notice tone="bad" title={error} /> : <p className="state-lead">Loading the setup…</p>}
      </main>
    );
  }

  const configuredIds = new Set(setup.clinicians.map((c) => c.practitionerId));
  /** Switched on in AuraNoteTaker. */
  const onIds = new Set(setup.clinicians.filter((c) => c.active).map((c) => c.practitionerId));
  /** Switched off here on purpose (e.g. duplicates in Dentally): hidden unless asked for. */
  const offIds = new Set(setup.clinicians.filter((c) => !c.active).map((c) => c.practitionerId));
  const isHidden = (p: { practitionerId: string; active: boolean }) => !onIds.has(p.practitionerId) && (!p.active || offIds.has(p.practitionerId));
  const configuredRooms = new Set(setup.surgeries.map((s) => s.roomId));
  const activeClinicians = setup.clinicians.filter((c) => c.active);

  return (
    <main className="setup admin">
      <div className="state-heading">
        <h1>Set up {setup.clinicName}</h1>
        {onClose && hasClinicalRole && (
          <button type="button" className="link-button" onClick={() => void onClose()}>
            Back to the clinical screen
          </button>
        )}
      </div>
      {onClose && !hasClinicalRole && (
        <Notice
          tone="info"
          title="To use the clinical screen, give yourself a clinical role"
          action={
            <button type="button" className="button button-secondary" onClick={() => void onClose()}>
              Go to the clinical screen
            </button>
          }
        >
          Under Staff, edit your own entry, tick Dentist (or your role), choose your diary, and save. Then go to the clinical screen.
        </Notice>
      )}
      {error && <Notice tone="bad" title={error} />}
      {saved && <Notice tone="info" title={`${saved} saved.`} />}
      {setup.dentallyError && (
        <Notice tone="warn" title="Dentally is not responding">
          Clinicians and surgeries come from Dentally, so they cannot be changed until it is back. You can still manage staff.
        </Notice>
      )}

      {setup.dentally && (
        <>
          <section className="setup-group" aria-labelledby="clinicians-heading">
            <h2 id="clinicians-heading">Clinicians</h2>
            <p className="setup-lead">Tick the Dentally practitioners whose diaries AuraNoteTaker should use. Practitioners inactive in Dentally, and any you have switched off here, are hidden.</p>
            <ul className="admin-list">
              {setup.dentally.practitioners
                // Active Dentally practitioners only, plus anyone already set up (so they can be switched off).
                .filter((p) => showInactive || !isHidden(p))
                .map((p) => {
                const d = clinicians[p.practitionerId] ?? { include: false, type: 'DENTIST' as ClinicianType };
                return (
                  <li key={p.practitionerId} className="admin-row">
                    <label className="admin-check">
                      <input
                        type="checkbox"
                        checked={d.include}
                        onChange={(e) => setClinicians((prev) => ({ ...prev, [p.practitionerId]: { ...d, include: e.target.checked } }))}
                      />
                      <span>{p.displayName}</span>
                      <span className="admin-sub mono-digits">Dentally {p.practitionerId}</span>
                    </label>
                    <select
                      aria-label={`Role of ${p.displayName}`}
                      value={d.type}
                      onChange={(e) => setClinicians((prev) => ({ ...prev, [p.practitionerId]: { ...d, type: e.target.value as ClinicianType } }))}
                    >
                      {(Object.keys(TYPE_LABELS) as ClinicianType[]).map((t) => (
                        <option key={t} value={t}>
                          {TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
            {setup.dentally.practitioners.some(isHidden) && (
              <button type="button" className="link-button" onClick={() => setShowInactive((v) => !v)}>
                {showInactive
                  ? 'Hide switched-off and inactive practitioners'
                  : ((n) => `Show ${n} switched-off or inactive practitioner${n === 1 ? '' : 's'}`)(setup.dentally.practitioners.filter(isHidden).length)}
              </button>
            )}
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() =>
                void save('Clinicians', () =>
                  backend.saveClinicians(
                    Object.entries(clinicians)
                      .filter(([id, d]) => d.include || configuredIds.has(id))
                      .map(([practitionerId, d]) => ({ practitionerId, clinicianType: d.type, active: d.include })),
                  ),
                )
              }
            >
              Save clinicians
            </button>
          </section>

          <section className="setup-group" aria-labelledby="surgeries-heading">
            <h2 id="surgeries-heading">Surgeries</h2>
            <p className="setup-lead">Tick the surgeries with a computer running AuraNoteTaker.</p>
            {setup.dentally.rooms.length === 0 && (
              <Notice tone="info" title="Dentally does not list your surgery rooms">
                Add your surgeries by name below instead. Dentally returned {setup.roomsReport?.returned ?? 0} room
                {setup.roomsReport?.returned === 1 ? '' : 's'}
                {setup.roomsReport?.bySite ? ' (asked site by site)' : ''}
                {setup.roomsReport && Object.keys(setup.roomsReport.rejected).length > 0
                  ? `; not readable: ${Object.entries(setup.roomsReport.rejected)
                      .map(([reason, n]) => `${n} ${reason.toLowerCase().replace(/_/g, ' ')}`)
                      .join(', ')}`
                  : ''}
                {setup.roomsReport && setup.roomsReport.fieldNames.length > 0 ? ` (fields: ${setup.roomsReport.fieldNames.join(', ')})` : ''}.
              </Notice>
            )}
            <ul className="admin-list">
              {setup.dentally.rooms.map((r) => (
                <li key={r.roomId} className="admin-row">
                  <label className="admin-check">
                    <input type="checkbox" checked={rooms[r.roomId] ?? false} onChange={(e) => setRooms((prev) => ({ ...prev, [r.roomId]: e.target.checked }))} />
                    <span>{r.name}</span>
                    <span className="admin-sub mono-digits">Dentally {r.roomId}</span>
                  </label>
                </li>
              ))}
              {setup.surgeries
                .filter((x) => x.roomId === null)
                .map((x) => (
                  <li key={x.surgeryId} className="admin-row">
                    <label className="admin-check">
                      <input
                        type="checkbox"
                        checked={named[x.surgeryId] ?? false}
                        onChange={(e) => setNamed((prev) => ({ ...prev, [x.surgeryId]: e.target.checked }))}
                      />
                      <span>{x.name}</span>
                    </label>
                  </li>
                ))}
            </ul>
            <div className="admin-add">
              <label className="field">
                <span className="field-label">Add a surgery</span>
                <input className="input" value={newSurgery} maxLength={40} placeholder="For example, Surgery 1" onChange={(e) => setNewSurgery(e.target.value)} />
              </label>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || newSurgery.trim().length === 0}
                onClick={() =>
                  void save('Surgery', () => backend.saveSurgeries([{ surgeryId: null, name: newSurgery.trim(), active: true }]), () => setNewSurgery(''))
                }
              >
                Add surgery
              </button>
            </div>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() =>
                void save('Surgeries', () =>
                  backend.saveSurgeries([
                    ...Object.entries(rooms)
                      .filter(([id, on]) => on || configuredRooms.has(id))
                      .map(([roomId, active]) => ({ roomId, active })),
                    ...setup.surgeries
                      .filter((x) => x.roomId === null)
                      .map((x) => ({ surgeryId: x.surgeryId, name: x.name, active: named[x.surgeryId] ?? false })),
                  ]),
                )
              }
            >
              Save surgeries
            </button>
          </section>
        </>
      )}

      <section className="setup-group" aria-labelledby="staff-heading">
        <h2 id="staff-heading">Staff</h2>
        <p className="setup-lead">
          Who can use AuraNoteTaker and what they can do. Each person also needs an invitation to the AuraNoteTaker app in Base44, using the
          same email address.
        </p>
        <ul className="admin-list">
          {setup.staff.map((x) => (
            <li key={x.email} className={`admin-row ${x.active ? '' : 'is-muted'}`}>
              <span>
                <strong>{x.displayName}</strong> <span className="admin-sub">{x.email}</span>
                <br />
                <span className="admin-sub">
                  {x.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                  {x.clinicianId ? `, linked to ${setup.clinicians.find((c) => c.practitionerId === x.clinicianId)?.displayName ?? x.clinicianId}` : ''}
                  {x.active ? '' : ', no access'}
                </span>
              </span>
              <button type="button" className="link-button" onClick={() => setProfile({ ...x })}>
                Edit {x.displayName}
              </button>
            </li>
          ))}
        </ul>

        <div className="admin-form" aria-label="Staff member">
          <h3>{setup.staff.some((x) => x.email === profile.email.trim().toLowerCase()) ? 'Edit staff member' : 'Add a staff member'}</h3>
          <label className="field">
            <span className="field-label">Email (their Base44 sign-in)</span>
            <input className="input" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" value={profile.displayName} maxLength={80} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} />
          </label>
          <fieldset className="field">
            <legend className="field-label">Roles</legend>
            {Object.entries(ROLE_LABELS).map(([role, label]) => (
              <label key={role} className="admin-check">
                <input
                  type="checkbox"
                  checked={profile.roles.includes(role)}
                  onChange={(e) =>
                    setProfile({ ...profile, roles: e.target.checked ? [...profile.roles, role] : profile.roles.filter((r) => r !== role) })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span className="field-label">Their own diary in Dentally (clinicians only)</span>
            <select value={profile.clinicianId ?? ''} onChange={(e) => setProfile({ ...profile, clinicianId: e.target.value || null })}>
              <option value="">None</option>
              {activeClinicians.map((c) => (
                <option key={c.practitionerId} value={c.practitionerId}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={profile.active} onChange={(e) => setProfile({ ...profile, active: e.target.checked })} />
            <span>Has access</span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !profile.email.trim() || !profile.displayName.trim() || profile.roles.length === 0}
              onClick={() => void save('Staff member', () => backend.saveStaffProfile(profile), () => setProfile(emptyProfile))}
            >
              Save staff member
            </button>
            <button type="button" className="button button-quiet" onClick={() => setProfile(emptyProfile)}>
              Clear
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
