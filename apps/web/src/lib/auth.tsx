import type { Role } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useToast } from '../components/feedback';
import { api, ApiError, EXPIRED_FLAG, get, post, setCsrfToken, SESSION_EXPIRED_MESSAGE } from './api';
import { clearAllDrafts } from './drafts';

export type AuthMethod = 'entra' | 'password' | 'breakglass' | 'local' | 'demo';

export interface Me {
  user: { id: string; email: string; name: string; role: Role; isBreakglass: boolean; isDemo: boolean; hasPassword?: boolean };
  csrfToken: string;
  authMethod: AuthMethod;
  sessionExpiresAt: string;
  /** The user signed in with a temporary password and must choose a new one before anything else. */
  mustChangePassword?: boolean;
  /** Until when the sign-in counts as recent for sensitive settings (null: not recent). */
  recentAuthUntil?: string | null;
  /** Minutes without requests after which the server ends the session. */
  idleMinutes?: number;
  features: { local: boolean; demo: boolean; scannerAws: boolean; scannerMs: boolean; scannerMsClientId: string | null };
}

/** Sign-in methods offered on the login page (public, no session needed). */
export interface AuthConfig {
  entra: boolean;
  password: boolean;
  breakglass: boolean;
  demoLogin: boolean;
  local: boolean;
  setupRequired: boolean;
}

export const AUTH_CONFIG_KEY = ['auth-config'] as const;

export function useAuthConfig() {
  return useQuery({ queryKey: AUTH_CONFIG_KEY, queryFn: () => get<AuthConfig>('/api/auth/config') });
}

/**
 * Temporary password typed on the login page, kept in memory only (never in storage) so the forced password change
 * does not ask for it again. Cleared after the change.
 */
let signInPassword: string | null = null;
export function rememberSignInPassword(pw: string | null) {
  signInPassword = pw;
}
export function peekSignInPassword() {
  return signInPassword;
}

/**
 * Local container mode: the one-time startup link (/?local_token=...) printed in the container log. Read once at
 * load and removed from the address bar right away, so it does not stay in the history or get bookmarked.
 */
let localToken: string | null = (() => {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('local_token');
    if (!token) return null;
    url.searchParams.delete('local_token');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return token;
  } catch {
    return null;
  }
})();

/** Server message when a local container session needs the startup link. */
const LOCAL_LINK_MESSAGE = /sign-in link printed in the container log/i;

interface AuthState {
  me: Me | null;
  loading: boolean;
  /** Local container mode without a session: the user has to open the link printed by the container. */
  localLinkRequired: boolean;
  logout(): Promise<void>;
}

const AuthCtx = createContext<AuthState>({ me: null, loading: true, localLinkRequired: false, logout: async () => {} });

/** Fetches the session; the stored local startup token is sent once, as a header (headers are not logged). */
export async function fetchMe(): Promise<Me> {
  const token = localToken;
  localToken = null;
  const me = await api<Me>('/api/auth/me', token ? { headers: { 'x-local-token': token } } : {});
  setCsrfToken(me.csrfToken);
  return me;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const localLinkRequired = useRef(false);
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await fetchMe();
        localLinkRequired.current = false;
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          localLinkRequired.current = LOCAL_LINK_MESSAGE.test(e.message);
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const onUnauthorized = () => {
      setCsrfToken('');
      qc.setQueryData(['me'], null);
    };
    // A write failed because the session ended: keep the page (and its unsaved input) and offer to sign in again.
    // Drafts of the organisation forms are kept in sessionStorage and restored after signing in.
    const onReauth = () =>
      toast.error(SESSION_EXPIRED_MESSAGE, {
        action: {
          label: 'Sign in again',
          onClick: () => {
            window.dispatchEvent(new Event('qs:save-drafts'));
            try {
              sessionStorage.setItem(EXPIRED_FLAG, '1');
            } catch {
              /* storage unavailable */
            }
            onUnauthorized();
          },
        },
      });
    // Any request refused because a temporary password must be replaced: reload the session, the route guard then
    // shows the change password page.
    const onPasswordChange = () => void qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener('qs:unauthorized', onUnauthorized);
    window.addEventListener('qs:reauth', onReauth);
    window.addEventListener('qs:password-change-required', onPasswordChange);
    return () => {
      window.removeEventListener('qs:unauthorized', onUnauthorized);
      window.removeEventListener('qs:reauth', onReauth);
      window.removeEventListener('qs:password-change-required', onPasswordChange);
    };
  }, [qc, toast]);

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } catch (e) {
      // 401: the session had already ended, which is the outcome we want. Anything else: the session may still
      // be valid (database down, rate limited), so do not claim the user is signed out.
      if (!(e instanceof ApiError && e.status === 401)) {
        toast.error('Sign out failed. Try again.', { action: { label: 'Retry', onClick: () => void logout() } });
        return;
      }
    }
    clearAllDrafts();
    // Full page load: drops every cached query (organisation data included) and the in-memory CSRF token.
    window.location.assign('/login?signedOut=1');
  }, [toast]);

  return (
    <AuthCtx.Provider value={{ me: q.data ?? null, loading: q.isLoading, localLinkRequired: !q.data && localLinkRequired.current, logout }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

/** Role-based checks for global actions (creating an organisation, admin pages). */
export function useCan() {
  const { me } = useAuth();
  const role = me?.user.role;
  return { write: role === 'admin' || role === 'consultant', admin: role === 'admin' };
}

/** A user's access to one organisation, as returned by the API (`myAccess`). */
export type CustomerAccess = 'admin' | 'owner' | 'edit' | 'view';

/** Per-organisation checks: edit covers scans, triage and details; manage covers sharing, transfer and delete. */
export function accessCan(access: CustomerAccess | null | undefined) {
  return { edit: Boolean(access) && access !== 'view', manage: access === 'owner' || access === 'admin' };
}
