import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, ROLE_LABELS, ROLES, type Role } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, KeyRound, LogOut, Pencil, RefreshCw, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { DataTable } from '../components/data-table';
import { AsyncButton, useToast } from '../components/feedback';
import { isReauthCancelled, useReauth } from '../components/reauth';
import { Alert, Badge, Button, Card, CopyButton, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select, Toggle } from '../components/ui';
import { del, get, patch, post } from '../lib/api';
import { useAuth, useAuthConfig } from '../lib/auth';
import { generatePassword } from '../lib/password';
import { fmtDateTime } from '../lib/format';
import { useDocumentTitle } from '../lib/use-document-title';

const ROLE_DESC: Record<Role, string> = {
  admin: 'Manages users and settings, and can see and manage all organisations.',
  consultant: 'Creates organisations and runs scans. Sees only organisations they own or that are shared with them.',
  viewer: 'Can only view organisations that are shared with them. Cannot run scans or own organisations.',
};

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  isBreakglass: boolean;
  isDemo: boolean;
  lastLoginAt: string | null;
  activeSessions: number;
  ownedCount: number;
  hasPassword?: boolean;
  mustChangePassword?: boolean;
}

type SignIn = 'microsoft' | 'password';

interface OwnedOrg {
  id: string;
  name: string;
}

const orgs = (n: number) => `${n} organisation${n === 1 ? '' : 's'}`;

/** Accounts that can take over owned organisations: active analysts and admins, no shared or emergency accounts. */
const ownerCandidates = (all: UserRow[], target: UserRow) => all.filter((u) => u.id !== target.id && u.active && u.role !== 'viewer' && !u.isDemo && !u.isBreakglass);

/** The organisation list from a 409 answer, when the API client exposes the response body. */
function ownedFromError(e: unknown): OwnedOrg[] | null {
  const body = (e as { data?: { ownedOrganisations?: unknown }; body?: { ownedOrganisations?: unknown } } | null) ?? null;
  const list = body?.data?.ownedOrganisations ?? body?.body?.ownedOrganisations;
  return Array.isArray(list) ? (list as OwnedOrg[]) : null;
}

/** Success message, plus where owned organisations went. */
function withMoved(text: string, reassigned: number | undefined, to: UserRow | undefined) {
  return reassigned && to ? `${text} ${orgs(reassigned)} moved to ${to.name || to.email}.` : text;
}

/**
 * New-owner picker shown when a change would leave organisations with an owner who cannot keep them
 * (deleted, deactivated or Viewer). The admin must pick someone in the same step.
 */
function NewOwnerPicker({ target, all, owned, value, onChange, verb }: { target: UserRow; all: UserRow[]; owned: OwnedOrg[] | null; value: string; onChange(v: string): void; verb: string }) {
  const candidates = ownerCandidates(all, target);
  const count = owned?.length ?? all.find((u) => u.id === target.id)?.ownedCount ?? target.ownedCount;
  return (
    <div className="space-y-3 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
      <p className="text-sm text-amber-900">
        {target.name || target.email} owns {orgs(count)}. Choose who owns {count === 1 ? 'it' : 'them'} before you {verb} this user.
      </p>
      {owned && owned.length > 0 && (
        <ul className="list-inside list-disc text-sm text-amber-900">
          {owned.map((o) => (
            <li key={o.id}>{o.name}</li>
          ))}
        </ul>
      )}
      {candidates.length === 0 ? (
        <p className="text-sm text-amber-900">There is no other active analyst or admin to take over. Invite one first.</p>
      ) : (
        <Field label="New owner" required hint="The new owner manages access and can delete these organisations.">
          <Select value={value} required onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose a person</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ? `${u.name} (${u.email})` : u.email}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}

/** A temporary password: generated in the browser, editable, with a button for a new one. */
function TempPasswordField({ value, onChange, error, label = 'Temporary password' }: { value: string; onChange(v: string): void; error?: string; label?: string }) {
  return (
    <Field label={label} required error={error} hint="Generated for you. They must replace it when they first sign in.">
      <div className="flex items-center gap-2">
        <Input
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          className="font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => onChange(generatePassword())}>
          Generate
        </Button>
      </div>
    </Field>
  );
}

/** Shown once after a temporary password was set: the only time it is visible. */
function TempPasswordResult({ email, password }: { email: string; password: string }) {
  return (
    <div className="space-y-3 text-sm text-slate-600">
      <p>
        Temporary password for <span className="font-medium text-slate-900">{email}</span>:
      </p>
      <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 px-3 py-2">
        <code className="break-all font-mono text-sm text-slate-100">{password}</code>
        <span className="shrink-0 rounded-md bg-white/90">
          <CopyButton value={password} ariaLabel="Copy temporary password" />
        </span>
      </div>
      <Alert tone="warn">
        This is the only time the password is shown. Share it securely, for example in person or by phone, not in the same message as the sign-in address. They must choose
        their own password when they first sign in at {window.location.origin}.
      </Alert>
    </div>
  );
}

const passwordError = (pw: string) => (pw.length < PASSWORD_MIN_LENGTH ? `Use at least ${PASSWORD_MIN_LENGTH} characters.` : undefined);

function UserForm({ user, all, onClose }: { user?: UserRow; all: UserRow[]; onClose(): void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: user?.email ?? '', name: user?.name ?? '', role: (user?.role ?? 'consultant') as Role, active: user?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [owned, setOwned] = useState<OwnedOrg[] | null>(null);
  const toast = useToast();
  const { withReauth } = useReauth();
  const activeId = useId();
  const signInName = useId();
  const cfg = useAuthConfig();
  const passwordOn = Boolean(cfg.data?.password);
  const entraOn = cfg.data?.entra ?? true;
  const [signIn, setSignIn] = useState<SignIn>('microsoft');
  const [tempPassword, setTempPassword] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // Fewer choices: with only password sign-in available, new users get a password.
  useEffect(() => {
    if (!user && cfg.data && cfg.data.password && !cfg.data.entra) setSignIn('password');
  }, [user, cfg.data]);
  useEffect(() => {
    if (signIn === 'password' && !tempPassword) setTempPassword(generatePassword());
  }, [signIn, tempPassword]);
  const withPassword = !user && passwordOn && signIn === 'password';
  const tempError = withPassword && showErrors ? passwordError(tempPassword) : undefined;

  // Only fields that differ from the loaded user are sent (a name fix must not touch role or active).
  const changes: Partial<Pick<UserRow, 'name' | 'role' | 'active'>> = {};
  if (user) {
    if (form.name !== user.name) changes.name = form.name;
    if (form.role !== user.role) changes.role = form.role;
    if (form.active !== user.active) changes.active = form.active;
  }
  const deactivate = Boolean(user?.active) && changes.active === false;
  const demote = Boolean(user) && user!.role !== 'viewer' && changes.role === 'viewer';
  // The list is refetched after a 409, so a fresh row reflects organisations created in the meantime.
  const ownedCount = (all.find((u) => u.id === user?.id) ?? user)?.ownedCount ?? 0;
  const needsOwner = Boolean(user) && (deactivate || demote) && (ownedCount > 0 || Boolean(owned?.length));
  const verb = deactivate ? 'deactivate' : 'demote';

  const save = async () => {
    if (user && !Object.keys(changes).length) return onClose();
    setShowErrors(true);
    if (withPassword && passwordError(tempPassword)) return;
    if (needsOwner && !newOwnerId) {
      setErr('Choose a new owner for the organisations this user owns.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (user) {
        const r = await patch<{ ok: true; reassigned?: number }>(`/api/users/${user.id}`, { ...changes, ...(needsOwner ? { newOwnerId } : {}) });
        await qc.invalidateQueries({ queryKey: ['users'] });
        toast.success(withMoved('User updated.', r.reassigned, all.find((u) => u.id === newOwnerId)));
      } else {
        await withReauth(() => post('/api/users', { ...form, ...(withPassword ? { temporaryPassword: tempPassword } : {}) }));
        await qc.invalidateQueries({ queryKey: ['users'] });
        toast.success(`${form.email} can now sign in at ${window.location.origin}.`);
        if (withPassword) {
          setCreated({ email: form.email, password: tempPassword });
          return;
        }
      }
      onClose();
    } catch (e: any) {
      if (isReauthCancelled(e)) return;
      const list = ownedFromError(e);
      if (list) setOwned(list);
      setErr(e.message);
      // The owned count may have changed since the list was loaded.
      if (e?.status === 409) void qc.invalidateQueries({ queryKey: ['users'] });
    } finally {
      setBusy(false);
    }
  };
  if (created)
    return (
      <Modal
        open
        onClose={onClose}
        title="User added"
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <TempPasswordResult email={created.email} password={created.password} />
      </Modal>
    );
  return (
    <Modal
      open
      busy={busy}
      onClose={onClose}
      title={user ? 'Edit user' : 'Add user'}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={needsOwner && !newOwnerId}>
            {user ? 'Save' : 'Add user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email" hint={!user && !withPassword ? 'The address of their Microsoft account in your tenant.' : undefined}>
          <Input type="email" autoComplete="off" value={form.email} disabled={Boolean(user)} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Name">
          <Input autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Role" hint={ROLE_DESC[form.role]}>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        {!user && passwordOn && (
          <fieldset>
            <legend className="mb-1.5 block text-sm font-medium text-slate-700">Sign-in</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ['microsoft', 'Microsoft only', entraOn ? 'Signs in with their Microsoft account.' : 'Microsoft sign-in is currently turned off.'],
                  ['password', 'Email and password', 'You give them a temporary password.'],
                ] as const
              ).map(([value, label, desc]) => (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2.5 ring-1 transition ${signIn === value ? 'bg-brand-50 ring-brand-300' : 'ring-slate-200 hover:bg-slate-50'}`}
                >
                  <input
                    type="radio"
                    name={signInName}
                    value={value}
                    checked={signIn === value}
                    onChange={() => setSignIn(value)}
                    aria-describedby={`${signInName}-${value}`}
                    className="mt-0.5 accent-brand-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-900">{label}</span>
                    <span id={`${signInName}-${value}`} aria-hidden className="block text-xs text-slate-500">
                      {desc}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {withPassword && (
          <TempPasswordField value={tempPassword} onChange={setTempPassword} error={tempError} />
        )}
        {!user && !withPassword && <p className="text-xs text-slate-500">No email is sent: tell them where to sign in.</p>}
        {user && (
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
            <div id={activeId} className="text-sm font-medium text-slate-800">
              Active
            </div>
            <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} labelledBy={activeId} />
          </div>
        )}
        {user && needsOwner && <NewOwnerPicker target={user} all={all} owned={owned} value={newOwnerId} onChange={setNewOwnerId} verb={verb} />}
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

function DeleteUserModal({ user, all, onClose }: { user: UserRow; all: UserRow[]; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [newOwnerId, setNewOwnerId] = useState('');
  const [owned, setOwned] = useState<OwnedOrg[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownedCount = (all.find((u) => u.id === user.id) ?? user).ownedCount;
  const needsOwner = ownedCount > 0 || Boolean(owned?.length);
  const remove = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await del<{ ok: true; reassigned?: number }>(`/api/users/${user.id}${needsOwner && newOwnerId ? `?newOwnerId=${encodeURIComponent(newOwnerId)}` : ''}`);
      await qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(withMoved(`${user.email} was deleted.`, r.reassigned, all.find((u) => u.id === newOwnerId)));
      onClose();
    } catch (e: any) {
      const list = ownedFromError(e);
      if (list) setOwned(list);
      setErr(e.message);
      if (e?.status === 409) void qc.invalidateQueries({ queryKey: ['users'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      busy={busy}
      onClose={onClose}
      title="Delete user?"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={needsOwner && !newOwnerId} onClick={() => void remove()}>
            Delete user
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p>
          <span className="font-medium text-slate-900">{user.email}</span> can no longer sign in and their sessions end immediately. The audit log keeps their past activity.
        </p>
        {needsOwner && <NewOwnerPicker target={user} all={all} owned={owned} value={newOwnerId} onChange={setNewOwnerId} verb="delete" />}
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: UserRow; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { withReauth } = useReauth();
  const [pw, setPw] = useState(() => generatePassword());
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = user.name || user.email;
  const invalid = passwordError(pw);
  const submit = async () => {
    if (invalid) return setErr(invalid);
    setBusy(true);
    setErr(null);
    try {
      await withReauth(() => post(`/api/users/${user.id}/reset-password`, { temporaryPassword: pw }));
      await qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(`A temporary password was set for ${user.email}.`);
      setDone(true);
    } catch (e) {
      if (!isReauthCancelled(e)) setErr(e instanceof Error ? e.message : 'The password could not be reset.');
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <Modal open onClose={onClose} title="Temporary password set" footer={<Button onClick={onClose}>Done</Button>}>
        <TempPasswordResult email={user.email} password={pw} />
      </Modal>
    );
  return (
    <Modal
      open
      busy={busy}
      onClose={onClose}
      title={user.hasPassword ? `Reset password of ${who}?` : `Give ${who} a password?`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {user.hasPassword ? 'Reset password' : 'Set password'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-slate-600">
          {user.hasPassword
            ? `Their current password stops working and all their sessions are signed out. They sign in with this temporary password and must then choose a new one.`
            : `They can then also sign in with their email address and this temporary password, and must choose a new one at first sign-in.`}
        </p>
        <TempPasswordField value={pw} onChange={setPw} />
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  useDocumentTitle('Users');
  const q = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/api/users') });
  const [editing, setEditing] = useState<UserRow | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const cfg = useAuthConfig();
  const passwordOn = Boolean(cfg.data?.password);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <PageLoader />;
  const all = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Only users added here can sign in."
        actions={
          <Button icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setEditing(null)}>
            Add user
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <DataTable
          storageKey="users"
          label="users"
          caption="Users"
          minWidth="58rem"
          rows={all}
          rowKey={(u) => u.id}
          rowClassName={(u) => (u.active ? undefined : 'bg-slate-50/60')}
          columns={[
            {
              key: 'user',
              header: 'User',
              sort: (u) => (u.name || u.email).toLowerCase(),
              render: (u) => (
                <>
                  <div className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                    {u.name}
                    {u.isBreakglass && (
                      <Badge className="bg-red-100 text-red-700">
                        <ShieldAlert className="size-3" aria-hidden /> Break glass
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </>
              ),
            },
            { key: 'role', header: 'Role', sort: (u) => ROLE_LABELS[u.role], render: (u) => <span className="text-slate-700">{ROLE_LABELS[u.role]}</span> },
            {
              key: 'owns',
              header: 'Owns',
              sort: (u) => u.ownedCount,
              align: 'right',
              render: (u) =>
                u.ownedCount > 0 ? (
                  <span className="text-slate-600" title={`Owns ${orgs(u.ownedCount)}`}>
                    {u.ownedCount}
                  </span>
                ) : (
                  <span className="text-slate-500">0</span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              sort: (u) => (u.active ? 0 : 1),
              render: (u) =>
                u.active ? (
                  <Badge className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">Active</Badge>
                ) : (
                  <Badge className="bg-slate-200 text-slate-700">Inactive</Badge>
                ),
            },
            {
              key: 'password',
              header: 'Password',
              sort: (u) => (u.mustChangePassword ? 2 : u.hasPassword ? 1 : 0),
              render: (u) =>
                u.hasPassword || u.mustChangePassword ? (
                  <div className="flex flex-wrap gap-1">
                    <Badge className="bg-slate-100 text-slate-700">Password</Badge>
                    {u.mustChangePassword && (
                      <Badge className="bg-amber-50 text-amber-800 ring-1 ring-amber-200">
                        <span title="Signs in with a temporary password and must choose a new one">Must change</span>
                      </Badge>
                    )}
                  </div>
                ) : (
                  <span className="text-slate-500">
                    <span aria-hidden>-</span>
                    <span className="sr-only">No password</span>
                  </span>
                ),
            },
            {
              key: 'lastLogin',
              header: 'Last sign-in',
              sort: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt) : null),
              render: (u) => (
                <span className="text-slate-600">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : u.isBreakglass || u.isDemo ? '-' : 'Invited, not signed in yet'}</span>
              ),
            },
            { key: 'sessions', header: 'Sessions', sort: (u) => u.activeSessions, align: 'right', render: (u) => <span className="text-slate-600">{u.activeSessions}</span> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              align: 'right',
              render: (u) =>
                !u.isBreakglass && (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Edit ${u.name || u.email}`} title="Edit" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(u)} />
                    {passwordOn && !u.isDemo && u.id !== me?.user.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`${u.hasPassword ? 'Reset password of' : 'Set a password for'} ${u.name || u.email}`}
                        title={u.hasPassword ? 'Reset password' : 'Set password'}
                        icon={<KeyRound className="size-3.5" aria-hidden />}
                        onClick={() => setResetting(u)}
                      />
                    )}
                    {u.activeSessions > 0 && u.id !== me?.user.id && (
                      <AsyncButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Sign out ${u.name || u.email} everywhere`}
                        title="Sign out everywhere"
                        icon={<LogOut className="size-3.5" aria-hidden />}
                        success={`${u.email} was signed out everywhere.`}
                        onClick={async () => {
                          await post(`/api/users/${u.id}/revoke-sessions`);
                          await refresh();
                        }}
                      />
                    )}
                    {u.id !== me?.user.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600"
                        aria-label={`Delete ${u.name || u.email}`}
                        title="Delete"
                        icon={<Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => setDeleting(u)}
                      />
                    )}
                  </div>
                ),
            },
          ]}
        />
      </Card>
      {editing !== undefined && <UserForm user={editing ?? undefined} all={all} onClose={() => setEditing(undefined)} />}
      {deleting && <DeleteUserModal user={deleting} all={all} onClose={() => setDeleting(null)} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
      <p className="mt-4 flex items-start gap-1.5 text-xs text-slate-500">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        Deactivating a user, lowering their role or resetting their password signs them out immediately. Renaming a user does not. Before you delete, deactivate or demote someone who owns organisations to Viewer, you choose a new owner for them.
      </p>
    </>
  );
}
