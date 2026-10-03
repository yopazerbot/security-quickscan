import { ROLE_LABELS, ROLES, type Role } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, LogOut, Pencil, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { AsyncButton, useToast } from '../components/feedback';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, Modal, PageHeader, PageLoader, Select, Toggle } from '../components/ui';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
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
}

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

function UserForm({ user, all, onClose }: { user?: UserRow; all: UserRow[]; onClose(): void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: user?.email ?? '', name: user?.name ?? '', role: (user?.role ?? 'consultant') as Role, active: user?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [owned, setOwned] = useState<OwnedOrg[] | null>(null);
  const toast = useToast();
  const activeId = useId();

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
        await post('/api/users', form);
        await qc.invalidateQueries({ queryKey: ['users'] });
        toast.success(`${form.email} can now sign in at ${window.location.origin}.`);
      }
      onClose();
    } catch (e: any) {
      const list = ownedFromError(e);
      if (list) setOwned(list);
      setErr(e.message);
      // The owned count may have changed since the list was loaded.
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
      title={user ? 'Edit user' : 'Invite user'}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={needsOwner && !newOwnerId}>
            {user ? 'Save' : 'Invite'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!user && <Alert>The user signs in with their Microsoft account from your tenant using this email address. No password is created and no email is sent: tell them where to sign in.</Alert>}
        <Field label="Email (Microsoft account)">
          <Input type="email" value={form.email} disabled={Boolean(user)} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
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

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  useDocumentTitle('Users');
  const q = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/api/users') });
  const [editing, setEditing] = useState<UserRow | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <PageLoader />;
  const all = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Only invited users can sign in. Authentication is handled by Microsoft Entra ID."
        actions={
          <Button icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setEditing(null)}>
            Invite user
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-3 font-medium">User</th>
                <th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Owns</th>
                <th className="px-3 py-3 font-medium">Last sign-in</th>
                <th className="px-3 py-3 font-medium">Sessions</th>
                <th className="px-6 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {all.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'bg-slate-50/60'}>
                  <td className="px-6 py-3">
                    <div className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      {u.name}
                      {u.isBreakglass && (
                        <Badge className="bg-red-100 text-red-700">
                          <ShieldAlert className="size-3" aria-hidden /> Break glass
                        </Badge>
                      )}
                      {!u.active && <Badge className="bg-slate-200 text-slate-700">Inactive</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td className="px-3 py-3 text-slate-700">{ROLE_LABELS[u.role]}</td>
                  <td className="px-3 py-3 text-slate-600">
                    {u.ownedCount > 0 ? <span title={`Owns ${orgs(u.ownedCount)}`}>{u.ownedCount}</span> : <span className="text-slate-500">0</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : u.isBreakglass || u.isDemo ? '-' : 'Invited, not signed in yet'}</td>
                  <td className="px-3 py-3 text-slate-600">{u.activeSessions}</td>
                  <td className="px-6 py-3 text-right">
                    {!u.isBreakglass && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Edit ${u.name || u.email}`} title="Edit" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(u)} />
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing !== undefined && <UserForm user={editing ?? undefined} all={all} onClose={() => setEditing(undefined)} />}
      {deleting && <DeleteUserModal user={deleting} all={all} onClose={() => setDeleting(null)} />}
      <p className="mt-4 flex items-start gap-1.5 text-xs text-slate-500">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        Deactivating a user or lowering their role signs them out immediately. Renaming a user does not. Before you delete, deactivate or demote someone who owns organisations to Viewer, you choose a new owner for them.
      </p>
    </>
  );
}
