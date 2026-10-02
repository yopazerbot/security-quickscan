import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { ToastProvider } from './components/feedback';
import { Layout } from './components/Layout';
import { PageLoader } from './components/ui';
import './index.css';
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

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
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
            <Route path="/login" element={<Login />} />
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
