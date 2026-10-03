import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PRODUCT_NAME } from '@qs/shared';
import { ShieldCheck, Terminal } from 'lucide-react';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { ToastProvider } from './components/feedback';
import { Layout } from './components/Layout';
import { PageLoader } from './components/ui';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { AuditPage } from './pages/Audit';
import { ConsentCallback } from './pages/ConsentCallback';
import { CustomerDetail } from './pages/CustomerDetail';
import { CustomerEdit } from './pages/CustomerEdit';
import { Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Report } from './pages/Report';
import { ScanProgress } from './pages/ScanProgress';
import { SettingsPage } from './pages/Settings';
import { UsersPage } from './pages/Users';
import { ScanWizard } from './pages/wizard/ScanWizard';

// No retry for answers that will not change (signed out, no access, not found).
const qc = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (n, e) => n < 1 && !(e instanceof ApiError && [401, 403, 404].includes(e.status)) } },
});

/**
 * Local installation in a container: a session starts only from the one-time link the container prints at
 * startup. There is no sign-in page to show, so explain where to find the link.
 */
function LocalLinkRequired() {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-brand-600">
            <ShieldCheck className="size-5 text-white" aria-hidden />
          </div>
          <span className="text-base font-semibold text-slate-900">{PRODUCT_NAME}</span>
        </div>
        <h1 className="text-xl font-semibold text-slate-900">Open the link from the container</h1>
        <p className="mt-2 text-sm text-slate-600">Open the link printed by the container (docker compose logs) to start a session.</p>
        <p className="mt-2 text-sm text-slate-600">
          This local installation has no sign-in page. When it starts, the container prints a one-time link that contains an access token. Opening that
          link in this browser starts your session.
        </p>
        <div className="mt-5 rounded-lg bg-slate-900 px-4 py-3 font-mono text-xs text-slate-100">
          <div className="mb-1 flex items-center gap-1.5 text-slate-400">
            <Terminal className="size-3.5" aria-hidden /> Find the link
          </div>
          docker compose logs | grep local_token
        </div>
        <p className="mt-4 text-xs text-slate-500">The link is valid until the container restarts. After a restart, the container prints a new one.</p>
      </div>
    </main>
  );
}

/** Shows the local-link explanation instead of the page when a local container session needs the startup link. */
function LocalGate({ children }: { children: ReactNode }) {
  const { me, loading, localLinkRequired } = useAuth();
  if (!loading && !me && localLinkRequired) return <LocalLinkRequired />;
  return <>{children}</>;
}

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { me, loading, localLinkRequired } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!me && localLinkRequired) return <LocalLinkRequired />;
  // The query string is kept: the admin-consent callback carries its result there.
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (admin && me.user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Keeps old /customers bookmarks working by redirecting to the matching /organisations URL. */
function LegacyCustomerRedirect({ suffix = '' }: { suffix?: string }) {
  const { customerId } = useParams();
  return <Navigate to={`/organisations${customerId ? `/${customerId}` : ''}${suffix}`} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route
              path="/login"
              element={
                <LocalGate>
                  <Login />
                </LocalGate>
              }
            />
            <Route
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="organisations" element={<Customers />} />
              <Route path="organisations/new" element={<CustomerEdit />} />
              <Route path="organisations/:customerId" element={<CustomerDetail />} />
              <Route path="organisations/:customerId/edit" element={<CustomerEdit />} />
              <Route path="customers" element={<LegacyCustomerRedirect />} />
              <Route path="customers/new" element={<LegacyCustomerRedirect suffix="/new" />} />
              <Route path="customers/:customerId" element={<LegacyCustomerRedirect />} />
              <Route path="customers/:customerId/edit" element={<LegacyCustomerRedirect suffix="/edit" />} />
              <Route path="scans/:scanId/wizard" element={<ScanWizard />} />
              <Route path="scans/:scanId/progress" element={<ScanProgress />} />
              <Route path="scans/:scanId/report" element={<Report />} />
              <Route path="consent/callback" element={<ConsentCallback />} />
              <Route path="admin/users" element={<Protected admin><UsersPage /></Protected>} />
              <Route path="admin/audit" element={<Protected admin><AuditPage /></Protected>} />
              <Route path="admin/settings" element={<Protected admin><SettingsPage /></Protected>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
