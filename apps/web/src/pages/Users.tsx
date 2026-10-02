import { ROLES, type Role } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Pencil, Plus, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHeader, PageLoader, Select, Toggle } from '../components/ui';
import { del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';

const ROLE_DESC: Record<Role, string> = {
  admin: 'Full access: users, settings, audit log and all customers.',
  consultant: 'Creates customers and runs scans for assigned customers.',
  viewer: 'Read-only access to reports of assigned customers.',
};

function UserForm({ user, onClose }: { user?: any; onClose(): void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: user?.email ?? '', name: user?.name ?? '', role: (user?.role ?? 'consultant') as Role, allCustomers: user?.allCustomers ?? false, active: user?.active ?? true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (user) await patch(`/api/users/${user.id}`, { name: form.name, role: form.role, allCustomers: form.allCustomers, active: form.active });
      else await post('/api/users', form);
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={user ? 'Edit user' : 'Invite user'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>{user ? 'Save' : 'Invite'}</Button></>}>
      <div className="space-y-4">
        {!user && <Alert>The user signs in with their Microsoft account from your tenant using this e-mail address. No password is created.</Alert>}
        <Field label="E-mail (Microsoft account)">
          <Input type="email" value={form.email} disabled={Boolean(user)} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Role" hint={ROLE_DESC[form.role]}>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
          </Select>
        </Field>
        {form.role !== 'admin' && (
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
            <div>
              <div className="text-sm font-medium text-slate-800">Access to all customers</div>
              <div className="text-xs text-slate-500">Otherwise assign customers individually on the customer page.</div>
            </div>
            <Toggle checked={form.allCustomers} onChange={(v) => setForm({ ...form, allCustomers: v })} />
          </div>
        )}
        {user && (
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
            <div className="text-sm font-medium text-slate-800">Active</div>
            <Toggle checked={form.active} onChange={(v) => setForm({ ...form, active: v })} />
          </div>
        )}
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </Modal>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => get<any[]>('/api/users') });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  if (q.isLoading) return <PageLoader />;
  return (
    <>
      <PageHeader title="Users" subtitle="Only invited users can sign in. Authentication is handled by Microsoft Entra ID." actions={<Button icon={<UserPlus className="size-4" />} onClick={() => setEditing(null)}>Invite user</Button>} />
      <Card>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-6 py-3 font-medium">User</th>
              <th className="px-3 py-3 font-medium">Role</th>
              <th className="px-3 py-3 font-medium">Customers</th>
              <th className="px-3 py-3 font-medium">Last sign-in</th>
              <th className="px-3 py-3 font-medium">Sessions</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(q.data ?? []).map((u) => (
              <tr key={u.id} className={u.active ? '' : 'opacity-50'}>
                <td className="px-6 py-3">
                  <div className="flex items-center gap-2 font-medium text-slate-900">
                    {u.name}
                    {u.isBreakglass && <Badge className="bg-red-100 text-red-700"><ShieldAlert className="size-3" /> Break glass</Badge>}
                    {!u.active && <Badge className="bg-slate-100 text-slate-500">Inactive</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className="px-3 py-3 capitalize">{u.role}</td>
                <td className="px-3 py-3 text-slate-600">{u.role === 'admin' || u.allCustomers ? 'All' : u.customerIds.length}</td>
                <td className="px-3 py-3 text-slate-600">{fmtDateTime(u.lastLoginAt)}</td>
                <td className="px-3 py-3 text-slate-600">{u.activeSessions}</td>
                <td className="px-6 py-3 text-right">
                  {!u.isBreakglass && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(u)} />
                      {u.activeSessions > 0 && u.id !== me?.user.id && (
                        <Button size="sm" variant="ghost" title="Sign out everywhere" icon={<LogOut className="size-3.5" />} onClick={async () => { await post(`/api/users/${u.id}/revoke-sessions`); await qc.invalidateQueries({ queryKey: ['users'] }); }} />
                      )}
                      {u.id !== me?.user.id && (
                        <Button size="sm" variant="ghost" className="text-red-600" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (confirm(`Delete ${u.email}?`)) { await del(`/api/users/${u.id}`); await qc.invalidateQueries({ queryKey: ['users'] }); } }} />
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing !== undefined && <UserForm user={editing ?? undefined} onClose={() => setEditing(undefined)} />}
      <p className="mt-4 flex items-center gap-1 text-xs text-slate-500"><Plus className="size-3" /> Deactivating a user or changing their role signs them out immediately.</p>
    </>
  );
}
