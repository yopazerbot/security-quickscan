import clsx from 'clsx';
import { Building2, LayoutDashboard, LogOut, Menu, ScrollText, Settings, ShieldAlert, ShieldCheck, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { SOURCE_URL } from '../lib/constants';

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
          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
          isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
        )
      }
    >
      <Icon className="size-[18px]" aria-hidden />
      {label}
    </NavLink>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-brand-600 shadow-lg shadow-brand-600/30">
        <ShieldCheck className="size-5 text-white" aria-hidden />
      </div>
      <div>
        <div className="text-sm font-semibold text-white">Security QuickScan</div>
        <div className="text-[11px] text-slate-400">ISO 27001 cloud posture</div>
      </div>
    </div>
  );
}

export function Layout() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const navigate = useNavigate();
  // Close the mobile menu after navigating.
  useEffect(() => setOpen(false), [loc.pathname]);
  // After Microsoft sign-in, continue to the page that asked for the login.
  useEffect(() => {
    let to: string | null = null;
    try {
      to = sessionStorage.getItem('qs_return_to');
      sessionStorage.removeItem('qs_return_to');
    } catch {
      /* storage unavailable */
    }
    if (to && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') && !to.startsWith('/login')) navigate(to, { replace: true });
  }, [navigate]);
  if (!me) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex min-h-full">
      {/* Mobile top bar */}
      <div className="no-print fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-ink px-4 lg:hidden">
        <Brand />
        <button type="button" className="rounded-lg p-2 text-slate-200 hover:bg-white/10" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
          <Menu className="size-5" />
        </button>
      </div>
      {open && <div className="no-print fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={() => setOpen(false)} aria-hidden />}

      <aside
        className={clsx(
          'no-print fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-ink px-3 py-5 transition-transform lg:w-60 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="mb-8 flex items-center justify-between px-3">
          <Brand />
          <button type="button" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 lg:hidden" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X className="size-5" />
          </button>
        </div>
        <nav className="space-y-1">
          {nav.map((n) => (
            <Item key={n.to} {...n} />
          ))}
        </nav>
        {me.user.role === 'admin' && (
          <>
            <div className="mb-2 mt-8 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Administration</div>
            <nav className="space-y-1">
              {adminNav
                .filter((n) => !(me.features.local && n.to === '/admin/users'))
                .map((n) => (
                  <Item key={n.to} {...n} />
                ))}
            </nav>
          </>
        )}
        <div className="mt-auto border-t border-white/10 px-1 pt-4">
          <div className="flex items-center gap-3 px-2">
            <div className="flex size-8 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white" aria-hidden>
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{me.user.name}</div>
              <div className="truncate text-xs capitalize text-slate-400">{me.user.isDemo ? 'Demo visitor' : me.user.role}</div>
            </div>
          </div>
          {me.features.local ? (
            <p className="mt-3 px-3 text-xs text-slate-400">Local installation, no sign-in required</p>
          ) : (
            <button
              type="button"
              className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/5 hover:text-white"
              onClick={() => void logout()}
            >
              <LogOut className="size-[18px]" aria-hidden />
              Sign out
            </button>
          )}
          <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener" className="mt-2 block px-3 text-[11px] text-slate-400 hover:text-slate-200">
            Source code (MIT)
          </a>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pt-14 lg:ml-60 lg:pt-0">
        {me.authMethod === 'breakglass' && (
          <div role="alert" className="no-print flex items-center gap-2 bg-red-600 px-4 py-2 text-sm font-medium text-white sm:px-8">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            Break-glass session: emergency access is logged. Restore Microsoft sign-in and sign out as soon as possible.
          </div>
        )}
        {me.user.isDemo ? (
          <div className="no-print bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950 sm:px-8">
            Demo session: you are exploring a fictional customer. Only simulated systems can be scanned.
          </div>
        ) : (
          me.features.demo && (
            <div className="no-print bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-900 sm:px-8">Demo mode is on: simulated systems and the fictional demo customer are available.</div>
          )
        )}
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
