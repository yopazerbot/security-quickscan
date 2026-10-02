import { DEFAULT_CONTEXT, type CustomerContext } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ContextForm, RiskProfilePanel } from '../components/ContextForm';
import { useToast } from '../components/feedback';
import { Alert, Button, Card, ErrorState, Field, Input, PageHeader, PageLoader, Textarea } from '../components/ui';
import { get, post, put } from '../lib/api';

export function CustomerEdit() {
  const { customerId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['customer', customerId], queryFn: () => get(`/api/customers/${customerId}`), enabled: Boolean(customerId) });
  const [form, setForm] = useState({ name: '', contactName: '', contactEmail: '', country: '', notes: '' });
  const [context, setContext] = useState<CustomerContext>(DEFAULT_CONTEXT);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (existing.data) {
      const c = existing.data;
      setForm({ name: c.name, contactName: c.contactName, contactEmail: c.contactEmail, country: c.country, notes: c.notes });
      setContext({ ...DEFAULT_CONTEXT, ...c.context });
    }
  }, [existing.data]);

  if (customerId && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  if (customerId && existing.isLoading) return <PageLoader />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = { ...form, context };
      const c = customerId ? await put<{ id: string }>(`/api/customers/${customerId}`, body) : await post<{ id: string }>('/api/customers', body);
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['customer', c.id] });
      toast.success(customerId ? 'Customer saved.' : 'Customer created.');
      nav(`/customers/${c.id}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The customer could not be saved.';
      setErr(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <PageHeader
        crumbs={<Link to="/customers" className="hover:text-slate-700">Customers</Link>}
        title={customerId ? `Edit ${existing.data?.name}` : 'New customer'}
        subtitle="The customer context determines the risk profile, the default evaluation criteria and the weighting of the score."
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Organisation">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer name" className="sm:col-span-2">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} autoFocus />
              </Field>
              <Field label="Contact person">
                <Input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} maxLength={200} />
              </Field>
              <Field label="Contact e-mail">
                <Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} maxLength={320} />
              </Field>
              <Field label="Country">
                <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} maxLength={100} />
              </Field>
              <Field label="Internal notes" className="sm:col-span-2">
                <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={10000} />
              </Field>
            </div>
          </Card>
          <Card title="Context and risk factors" subtitle="Answer from the customer's perspective. Every new scan uses this context; draft scans pick up changes automatically.">
            <ContextForm value={context} onChange={setContext} />
          </Card>
        </div>
        <div>
          <div className="sticky top-8 space-y-4">
            <Card>
              <div className="p-6">
                <RiskProfilePanel context={context} />
              </div>
            </Card>
            {err && (
              <div role="alert">
                <Alert tone="error" title="Not saved">
                  {err}
                </Alert>
              </div>
            )}
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {customerId ? 'Save changes' : 'Create customer'}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
