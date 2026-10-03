import { PRODUCT_NAME, ROLE_LABELS } from '@qs/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, Clock, LayoutDashboard, LogOut, Menu, ScrollText, Settings, ShieldAlert, ShieldCheck, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { EXPIRED_FLAG, lastServerContact, post } from '../lib/api';
import { fetchMe, useAuth, type Me } from '../lib/auth';
import { SOURCE_URL } from '../lib/constants';
import { fmtDateTime } from '../lib/format';
import { Button, Modal } from './ui';

/** Keep-alive: user input pings the session at most this often, so typing counts as activity. */
const PING_EVERY_MS = 5 * 60_000;
/** The expiry warning opens this long before the session ends. */
const WARN_BEFORE_MS = 2 * 60_000;
/** The server records activity at most every 30 seconds, so its idle clock can start up to 30 seconds earlier. */
const SERVER_SLACK_MS = 30_000;

/**
 * Warns before the session ends (idle timeout or absolute lifetime) and keeps it alive while the user is working:
 * typing and clicking count as activity even when they send no request.
 */
function SessionWatch({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { logout } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  const [warn, setWarn] = useState<null | 'idle' | 'absolute'>(null);
  const [busy, setBusy] = useState(false);
  const lastPing = useRef(0);
  const warnRef = useRef(warn);
  warnRef.current = warn;
  const local = me.features.local;
  const idleMs = (me.idleMinutes ?? 30) * 60_000;
  const absoluteAt = new Date(me.sessionExpiresAt).getTime();
  const idleAt = lastServerContact() + idleMs - SERVER_SLACK_MS;
  const deadline = Math.min(idleAt, absoluteAt);

  const ping = useCallback(async () => {
    lastPing.current = Date.now();
    try {
      qc.setQueryData(['me'], await fetchMe());
    } catch {
      /* a 401 signs the UI out (api.ts); other errors: try again on the next activity */
    }
    setNow(Date.now());
  }, [qc]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Activity keep-alive, throttled. Not while the warning is open: there the user decides.
  useEffect(() => {
    const onActivity = () => {
      if (warnRef.current) return;
      const t = Date.now();
      if (t - lastServerContact() > PING_EVERY_MS && t - lastPing.current > PING_EVERY_MS) void ping();
    };
    const opts = { capture: true, passive: true } as const;
    for (const ev of ['keydown', 'pointerdown', 'input'] as const) window.addEventListener(ev, onActivity, opts);
    return () => {
      for (const ev of ['keydown', 'pointerdown', 'input'] as const) window.removeEventListener(ev, onActivity, opts);
    };
  }, [ping]);

  useEffect(() => {
    if (now >= deadline) {
      if (local) {
        void ping();
        return;
      }
      // Ended: keep unsaved drafts, end the server session too (shared computers) and go to the sign-in page.
      window.dispatchEvent(new Event('qs:save-drafts'));
      try {
        sessionStorage.setItem(EXPIRED_FLAG, '1');
      } catch {
        /* storage unavailable */
      }
      void post('/api/auth/logout').catch(() => undefined);
      window.dispatchEvent(new Event('qs:unauthorized'));
      return;
    }
    if (!local && !warn && deadline - now <= WARN_BEFORE_MS) setWarn(absoluteAt <= idleAt ? 'absolute' : 'idle');
    if (warn && deadline - now > WARN_BEFORE_MS) setWarn(null);
  }, [now, deadline, absoluteAt, idleAt, warn, local, ping]);

  const signInAgain = () => {
    window.dispatchEvent(new Event('qs:save-drafts'));
    try {
      sessionStorage.setItem(EXPIRED_FLAG, '1');
    } catch {
      /* storage unavailable */
    }
    void post('/api/auth/logout').catch(() => undefined);
    window.dispatchEvent(new Event('qs:unauthorized'));
  };

  const minutes = Math.max(1, Math.ceil((deadline - now) / 60_000));
  return (
    <Modal
      open={Boolean(warn)}
      busy={busy}
      onClose={() => (warn === 'idle' ? void ping().then(() => setWarn(null)) : setWarn(null))}
      title={
        <span className="flex items-center gap-2">
          <Clock className="size-5 text-amber-600" aria-hidden /> Your session is about to expire
        </span>
      }
      footer={
        <>
          <Button variant="secondary" icon={<LogOut className="size-4" />} disabled={busy} onClick={() => void logout()}>
            Sign out
          </Button>
          {warn === 'idle' ? (
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await ping();
                setBusy(false);
                setWarn(null);
              }}
            >
              Stay signed in
            </Button>
          ) : (
            <Button onClick={signInAgain}>Sign in again</Button>
          )}
        </>
      }
    >
      <div className="space-y-2 text-sm text-slate-600">
        {warn === 'idle' ? (
          <p>
            You have not used {PRODUCT_NAME} for a while. For security you will be signed out in {minutes === 1 ? 'about a minute' : `about ${minutes} minutes`} unless you
            stay signed in.
          </p>
        ) : (
          <p>
            Sessions last a limited time. This session ends at {fmtDateTime(new Date(absoluteAt).toISOString())}. Sign in again now to continue without
            interruption.
          </p>
        )}
        <p>Unsaved changes to organisation details are kept in this browser tab and restored after you sign in.</p>
      </div>
    </Modal>
  );
}

/** Below the lg breakpoint the navigation is an off-canvas drawer. */
function useIsDesktop() {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setDesktop(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return desktop;
}

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/organisations', label: 'Organisations', icon: Building2 },
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
        <div className="text-sm font-semibold text-white">{PRODUCT_NAME}</div>
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
  const desktop = useIsDesktop();
  const drawer = !desktop;
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Close the mobile menu after navigating.
  useEffect(() => setOpen(false), [loc.pathname]);
  // Drawer open: focus its Close button; Escape closes it and returns focus to the menu button.
  useEffect(() => {
    if (!open || !drawer) return;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, drawer]);
  const closeMenu = () => {
    setOpen(false);
    menuButton.current?.focus();
  };
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
      <SessionWatch me={me} />
      {/* Mobile top bar */}
      <div inert={drawer && open} className="no-print fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between bg-ink px-4 lg:hidden">
        <Brand />
        <button
          ref={menuButton}
          type="button"
          className="rounded-lg p-2 text-slate-200 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="main-navigation"
          onClick={() => setOpen(true)}
        >
          <Menu className="size-5" />
        </button>
      </div>
      {open && <div className="no-print fixed inset-0 z-40 bg-slate-900/50 lg:hidden" onClick={closeMenu} aria-hidden />}

      <aside
        id="main-navigation"
        inert={drawer && !open}
        className={clsx(
          'no-print fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-ink px-3 py-5 lg:w-60 lg:translate-x-0 motion-safe:transition-transform',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="mb-8 flex items-center justify-between px-3">
          <Brand />
          <button
            ref={closeButton}
            type="button"
            className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 lg:hidden"
            aria-label="Close menu"
            onClick={closeMenu}
          >
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
              <div className="truncate text-xs text-slate-400">{me.user.isDemo ? 'Demo visitor' : ROLE_LABELS[me.user.role]}</div>
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

      <main inert={drawer && open} className="min-w-0 flex-1 pt-14 lg:ml-60 lg:pt-0">
        {me.authMethod === 'breakglass' && (
          <div role="alert" className="no-print flex items-center gap-2 bg-red-600 px-4 py-2 text-sm font-medium text-white sm:px-8">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            Break-glass session: emergency access is logged. Restore Microsoft sign-in and sign out as soon as possible.
          </div>
        )}
        {me.user.isDemo ? (
          <div className="no-print bg-amber-400 px-4 py-2 text-sm font-medium text-amber-950 sm:px-8">
            Demo session: you are exploring a fictional organisation. Only simulated systems can be scanned.
          </div>
        ) : (
          me.features.demo && (
            <div className="no-print bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-900 sm:px-8">
              {me.user.role === 'admin'
                ? 'Demo mode is on: simulated systems and the fictional demo organisation are available.'
                : 'Demo mode is on: simulated systems are available. An administrator can share the demo organisation with you.'}
            </div>
          )
        )}
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
