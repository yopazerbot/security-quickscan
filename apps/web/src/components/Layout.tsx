import clsx from 'clsx';
import { Building2, LayoutDashboard, LogOut, ScrollText, Settings, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/customers', label: 'Customers', icon: Building2 },
];
const adminNav = [
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
];

function Item({ to, label, icon: Icon, end }: { to: string; label: string; icon: typeof Users; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
          isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
        )
      }
    >
      <Icon className="size-[18px]" />
      {label}
    </NavLink>
  );
}

export function Layout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex min-h-full">
      <aside className="no-print fixed inset-y-0 left-0 flex w-60 flex-col bg-ink px-3 py-5">
        <div className="mb-8 flex items-center gap-2.5 px-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 shadow-lg shadow-brand-600/30">
            <ShieldCheck className="size-5 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">Security QuickScan</div>
            <div className="text-[11px] text-slate-500">ISO 27001 cloud posture</div>
          </div>
        </div>
        <nav className="space-y-1">
          {nav.map((n) => (
            <Item key={n.to} {...n} />
          ))}
        </nav>
        {me.user.role === 'admin' && (
          <>
            <div className="mb-2 mt-8 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Administration</div>
            <nav className="space-y-1">
              {adminNav.map((n) => (
                <Item key={n.to} {...n} />
              ))}
            </nav>
          </>
        )}
        <div className="mt-auto border-t border-white/10 px-1 pt-4">
          <div className="flex items-center gap-3 px-2">
            <div className="flex size-8 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">{initials}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{me.user.name}</div>
              <div className="truncate text-xs capitalize text-slate-500">{me.user.role}</div>
            </div>
            <button
              title="Sign out"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="ml-60 min-w-0 flex-1">
        {me.authMethod === 'breakglass' && (
          <div className="no-print flex items-center gap-2 bg-red-600 px-8 py-2 text-sm font-medium text-white">
            <ShieldAlert className="size-4" />
            Break-glass session: emergency access is logged. Restore Microsoft sign-in and sign out as soon as possible.
          </div>
        )}
        {me.features.demo && (
          <div className="no-print bg-amber-100 px-8 py-1.5 text-xs font-medium text-amber-900">Demo mode is enabled: simulated systems are available.</div>
        )}
        <div className="mx-auto max-w-7xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
