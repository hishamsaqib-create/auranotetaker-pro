import { useCallback, useEffect, useState } from 'react';
import type { ClinicSetupResponse } from '../../lib/server/handlers.ts';
import type { AppBackend, StaffProfileInput } from '../backend/types.ts';
import { Notice } from './Notice.tsx';
import { TemplateManager } from './TemplateManager.tsx';

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

const emptyProfile: StaffProfileInput = {
  email: '',
  displayName: '',
  roles: ['DENTIST'],
  clinicianId: null,
  worksWithClinicianId: null,
  defaultSurgeryId: null,
  active: true,
  invite: true,
};

const CLINICAL = ['DENTIST', 'THERAPIST', 'HYGIENIST', 'NURSE', 'AUDITOR'];
const PRIMARY_ROLES: [string, string][] = [
  ['DENTIST', 'Dentist'],
  ['THERAPIST', 'Therapist'],
  ['HYGIENIST', 'Hygienist'],
  ['NURSE', 'Nurse'],
  ['AUDITOR', 'Auditor (read only)'],
  ['NONE', 'Practice manager only'],
];

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
  const isExisting = setup.staff.some((x) => x.email === profile.email.trim().toLowerCase());
  const primaryRole = profile.roles.find((r) => CLINICAL.includes(r)) ?? 'NONE';
  const setPrimaryRole = (role: string) => {
    const others = profile.roles.filter((r) => !CLINICAL.includes(r));
    const roles = role === 'NONE' ? (others.length ? others : ['CLINIC_ADMIN']) : [role, ...others];
    // A nurse has no diary of their own: the chosen dentist becomes the one they work with, and back.
    const linked = profile.clinicianId ?? profile.worksWithClinicianId ?? null;
    const seesPatients = ['DENTIST', 'THERAPIST', 'HYGIENIST'].includes(role);
    setProfile({ ...profile, roles, clinicianId: seesPatients ? linked : null, worksWithClinicianId: role === 'NURSE' ? linked : null });
  };
  async function saveProfile() {
    const name = profile.displayName.trim();
    const wantedInvite = profile.invite === true;
    let invite: 'SENT' | 'FAILED' | null = null;
    await save(name, async () => {
      const r = await backend.saveStaffProfile(profile);
      invite = r.invite;
      return r;
    }, () => setProfile(emptyProfile));
    if (wantedInvite && invite === 'SENT') setSaved(`${name} saved and invited.`);
    if (wantedInvite && invite === 'FAILED') {
      setError(`${name} was saved, but the invitation could not be sent. Invite them from the AuraNoteTaker app's Users page in Base44, using the same email.`);
    }
  }

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
      {saved && <Notice tone="info" title={saved.endsWith('.') ? saved : `${saved} saved.`} />}
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
        <h2 id="staff-heading">Team</h2>
        <p className="setup-lead">Who can use AuraNoteTaker, what they do, and which dentist and surgery they usually work with.</p>
        <ul className="admin-list">
          {setup.staff.map((x) => (
            <li key={x.email} className={`admin-row ${x.active ? '' : 'is-muted'}`}>
              <span>
                <strong>{x.displayName}</strong> <span className="admin-sub">{x.email}</span>
                <br />
                <span className="admin-sub">
                  {x.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}
                  {((id) => (id ? `, with ${setup.clinicians.find((c) => c.practitionerId === id)?.displayName ?? id}` : ''))(x.clinicianId ?? x.worksWithClinicianId ?? null)}
                  {x.defaultSurgeryId ? `, ${setup.surgeries.find((y) => y.surgeryId === x.defaultSurgeryId)?.name ?? 'surgery'}` : ''}
                  {x.active ? '' : ', no access'}
                </span>
              </span>
              <button type="button" className="link-button" onClick={() => setProfile({ ...x, invite: false })}>
                Edit {x.displayName}
              </button>
            </li>
          ))}
        </ul>

        <div className="admin-form" aria-label="Team member">
          <h3>{isExisting ? `Edit ${profile.displayName || 'team member'}` : 'Add a team member'}</h3>
          <div className="admin-grid">
            <label className="field">
              <span className="field-label">Name</span>
              <input className="input" value={profile.displayName} maxLength={80} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Email (what they sign in with)</span>
              <input
                className="input"
                type="email"
                value={profile.email}
                disabled={isExisting}
                onChange={(e) => setProfile({ ...profile, email: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select value={primaryRole} onChange={(e) => setPrimaryRole(e.target.value)}>
                {PRIMARY_ROLES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{primaryRole === 'NURSE' ? 'Dentist they work with' : 'Their diary in Dentally'}</span>
              <select
                value={(primaryRole === 'NURSE' ? profile.worksWithClinicianId : profile.clinicianId) ?? ''}
                onChange={(e) =>
                  setProfile(
                    primaryRole === 'NURSE'
                      ? { ...profile, worksWithClinicianId: e.target.value || null, clinicianId: null }
                      : { ...profile, clinicianId: e.target.value || null, worksWithClinicianId: null },
                  )
                }
              >
                <option value="">None</option>
                {activeClinicians.map((c) => (
                  <option key={c.practitionerId} value={c.practitionerId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Usual surgery</span>
              <select value={profile.defaultSurgeryId ?? ''} onChange={(e) => setProfile({ ...profile, defaultSurgeryId: e.target.value || null })}>
                <option value="">None</option>
                {setup.surgeries
                  .filter((x) => x.active)
                  .map((x) => (
                    <option key={x.surgeryId} value={x.surgeryId}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={profile.roles.includes('CLINIC_ADMIN')}
              onChange={(e) =>
                setProfile({ ...profile, roles: e.target.checked ? [...profile.roles, 'CLINIC_ADMIN'] : profile.roles.filter((r) => r !== 'CLINIC_ADMIN') })
              }
            />
            <span>Can change clinic setup (practice manager)</span>
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={profile.active} onChange={(e) => setProfile({ ...profile, active: e.target.checked })} />
            <span>Has access</span>
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={profile.invite ?? false} onChange={(e) => setProfile({ ...profile, invite: e.target.checked })} />
            <span>Email them an invitation to AuraNoteTaker</span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !profile.email.trim() || !profile.displayName.trim() || profile.roles.length === 0}
              onClick={() => void saveProfile()}
            >
              {isExisting ? 'Save changes' : 'Add team member'}
            </button>
            <button type="button" className="button button-quiet" onClick={() => setProfile(emptyProfile)}>
              Clear
            </button>
          </div>
        </div>
      </section>

      <section className="setup-group" aria-label="Note templates">
        <TemplateManager backend={backend} />
      </section>
    </main>
  );
}
