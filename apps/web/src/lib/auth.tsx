import type { Role } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, get, post, setCsrfToken } from './api';

export interface Me {
  user: { id: string; email: string; name: string; role: Role; isBreakglass: boolean; isDemo: boolean };
  csrfToken: string;
  authMethod: string;
  sessionExpiresAt: string;
  features: { local: boolean; demo: boolean; scannerAws: boolean; scannerMs: boolean; scannerMsClientId: string | null };
}

const AuthCtx = createContext<{ me: Me | null; loading: boolean; logout(): Promise<void> }>({ me: null, loading: true, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await get<Me>('/api/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('qs:unauthorized', onUnauthorized);
    return () => window.removeEventListener('qs:unauthorized', onUnauthorized);
  }, [qc]);

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    // Full page load: drops every cached query (organisation data included) and the in-memory CSRF token.
    window.location.assign('/login?signedOut=1');
  };

  return <AuthCtx.Provider value={{ me: q.data ?? null, loading: q.isLoading, logout }}>{children}</AuthCtx.Provider>;
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
