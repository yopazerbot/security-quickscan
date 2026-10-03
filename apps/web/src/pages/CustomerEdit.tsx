import { customerInputSchema, DEFAULT_CONTEXT, type CustomerContext } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ContextForm, RiskProfilePanel } from '../components/ContextForm';
import { useToast } from '../components/feedback';
import { Alert, Button, Card, ErrorState, Field, Input, LinkButton, PageHeader, PageLoader, Textarea } from '../components/ui';
import { ApiError, get, post, put } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { clearDraft, loadDraft, usePersistDraft } from '../lib/drafts';
import { useDocumentTitle } from '../lib/use-document-title';

type FormFields = { name: string; contactName: string; contactEmail: string; country: string; notes: string };
type FieldName = keyof FormFields;
interface Draft {
  form: FormFields;
  context: CustomerContext;
}

const EMPTY: FormFields = { name: '', contactName: '', contactEmail: '', country: '', notes: '' };
const FIELD_ORDER: FieldName[] = ['name', 'contactName', 'contactEmail', 'country', 'notes'];
const fieldId = (f: FieldName) => `organisation-${f}`;

/** Readable messages per field, instead of the schema's technical wording. */
function messageFor(field: FieldName, code: string): string {
  if (field === 'name') return code === 'too_big' ? 'Use at most 200 characters.' : 'Enter the organisation name.';
  if (field === 'contactEmail') return code === 'too_big' ? 'Use at most 320 characters.' : 'Enter a valid email address, or leave it empty.';
  if (field === 'notes') return 'Use at most 10,000 characters.';
  if (field === 'contactName') return 'Use at most 200 characters.';
  return 'Use at most 100 characters.';
}

/** Server validation errors arrive as "field: message; field: message". Map known fields to readable messages. */
function serverFieldErrors(e: unknown): Partial<Record<FieldName, string>> {
  if (!(e instanceof ApiError) || e.status !== 400) return {};
  const out: Partial<Record<FieldName, string>> = {};
  if (e.fields) {
    for (const [k, v] of Object.entries(e.fields)) if ((FIELD_ORDER as string[]).includes(k)) out[k as FieldName] = v;
    return out;
  }
  for (const part of e.message.split(';')) {
    const key = part.split(':')[0]?.trim() as FieldName;
    if (FIELD_ORDER.includes(key)) out[key] = messageFor(key, /too big|at most/i.test(part) ? 'too_big' : 'invalid');
  }
  return out;
}

/** Only same-app paths are accepted as a return target. */
function safeReturnTo(v: string | null): string | null {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : null;
}

export function CustomerEdit() {
  const { customerId } = useParams();
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const can = useCan();
  const existing = useQuery({ queryKey: ['customer', customerId], queryFn: () => get(`/api/customers/${customerId}`), enabled: Boolean(customerId) });
  const [form, setForm] = useState<FormFields>(EMPTY);
  const [context, setContext] = useState<CustomerContext>(DEFAULT_CONTEXT);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const loadedKey = useRef<string | null>(null);
  useDocumentTitle(customerId ? `Edit ${existing.data?.name ?? 'organisation'}` : 'New organisation');

  // The saved values the form starts from: the organisation record, or empty for a new one.
  const baseline = useMemo<Draft | null>(() => {
    if (!customerId) return { form: EMPTY, context: DEFAULT_CONTEXT };
    const c = existing.data;
    if (!c) return null;
    return { form: { name: c.name, contactName: c.contactName, contactEmail: c.contactEmail, country: c.country, notes: c.notes }, context: { ...DEFAULT_CONTEXT, ...c.context } };
  }, [customerId, existing.data]);
  // Unsaved input survives an expired session in this tab (per user and organisation; no secrets in this form).
  const draftKey = me ? `${me.user.id}:organisation:${customerId ?? 'new'}` : null;
  const current = useMemo<Draft>(() => ({ form, context }), [form, context]);
  const dirty = Boolean(baseline) && loadedKey.current === draftKey && JSON.stringify(current) !== JSON.stringify(baseline);
  usePersistDraft(baseline && loadedKey.current === draftKey ? draftKey : null, current, dirty);

  // Fill the form once per organisation: from a stored draft when there is one, otherwise from the record.
  useEffect(() => {
    if (!baseline || !draftKey || loadedKey.current === draftKey) return;
    loadedKey.current = draftKey;
    const draft = loadDraft<Draft>(draftKey);
    if (draft?.form && draft.context && JSON.stringify(draft) !== JSON.stringify(baseline)) {
      setForm({ ...EMPTY, ...draft.form });
      setContext({ ...DEFAULT_CONTEXT, ...draft.context });
      setRestored(true);
    } else {
      setForm(baseline.form);
      setContext(baseline.context);
    }
  }, [baseline, draftKey]);

  if (customerId && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  if (customerId && existing.isLoading) return <PageLoader />;
  // View-only access: nothing to edit here.
  if (customerId && existing.data?.myAccess === 'view') return <Navigate to={`/organisations/${customerId}`} replace />;
  // Viewers cannot create organisations.
  if (!customerId && me && !can.write) return <Navigate to="/organisations" replace />;

  const setField = (f: FieldName, v: string) => {
    setForm((x) => ({ ...x, [f]: v }));
    if (errors[f]) setErrors((x) => ({ ...x, [f]: undefined }));
  };

  const focusFirst = (errs: Partial<Record<FieldName, string>>) => {
    const first = FIELD_ORDER.find((f) => errs[f]);
    if (first) document.getElementById(fieldId(first))?.focus();
  };

  const discardRestored = () => {
    if (draftKey) clearDraft(draftKey);
    if (baseline) {
      setForm(baseline.form);
      setContext(baseline.context);
    }
    setRestored(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const body = { ...form, context };
    const parsed = customerInputSchema.safeParse(body);
    if (!parsed.success) {
      const errs: Partial<Record<FieldName, string>> = {};
      let other = false;
      for (const issue of parsed.error.issues) {
        const f = issue.path[0] as FieldName;
        if (FIELD_ORDER.includes(f)) errs[f] ??= messageFor(f, issue.code);
        else other = true;
      }
      setErrors(errs);
      if (other) setErr('Some answers in the context questionnaire are not valid. Check them and try again.');
      focusFirst(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const c = customerId ? await put<{ id: string }>(`/api/customers/${customerId}`, body) : await post<{ id: string }>('/api/customers', body);
      if (draftKey) clearDraft(draftKey);
      loadedKey.current = null;
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['customer', c.id] });
      // Draft scans recompute their risk profile and default criteria from the organisation context.
      await qc.invalidateQueries({ queryKey: ['scan'] });
      await qc.invalidateQueries({ queryKey: ['criteria'] });
      toast.success(customerId ? 'Organisation saved.' : 'Organisation created.');
      nav(returnTo ?? `/organisations/${c.id}`);
    } catch (e) {
      const fieldErrs = serverFieldErrors(e);
      if (Object.keys(fieldErrs).length) {
        setErrors(fieldErrs);
        focusFirst(fieldErrs);
      } else {
        // Shown once, next to the save button (no extra toast).
        setErr(e instanceof Error ? e.message : 'The organisation could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  };

  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <form onSubmit={submit} noValidate>
      <PageHeader
        crumbs={
          <Link to="/organisations" className="hover:text-slate-700">
            Organisations
          </Link>
        }
        title={customerId ? `Edit ${existing.data?.name}` : 'New organisation'}
        subtitle="The organisation context determines the risk profile, the default evaluation criteria and the weighting of the score."
      />
      {restored && (
        <Alert tone="info" live className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Restored your unsaved changes.</span>
            <Button variant="secondary" size="sm" onClick={discardRestored}>
              Discard changes
            </Button>
          </div>
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Organisation">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={fieldId('name')} label="Organisation name" className="sm:col-span-2" required error={errors.name}>
                <Input value={form.name} onChange={(e) => setField('name', e.target.value)} maxLength={200} autoFocus={!restored} />
              </Field>
              <Field id={fieldId('contactName')} label="Contact person" error={errors.contactName}>
                <Input value={form.contactName} onChange={(e) => setField('contactName', e.target.value)} maxLength={200} />
              </Field>
              <Field id={fieldId('contactEmail')} label="Contact email" error={errors.contactEmail}>
                <Input type="email" value={form.contactEmail} onChange={(e) => setField('contactEmail', e.target.value)} maxLength={320} />
              </Field>
              <Field id={fieldId('country')} label="Country" error={errors.country}>
                <Input value={form.country} onChange={(e) => setField('country', e.target.value)} maxLength={100} />
              </Field>
              <Field id={fieldId('notes')} label="Internal notes" className="sm:col-span-2" error={errors.notes}>
                <Textarea value={form.notes} onChange={(e) => setField('notes', e.target.value)} maxLength={10000} />
              </Field>
            </div>
          </Card>
          <Card title="Context and risk factors" subtitle="Answer from the organisation's perspective. Every new scan uses this context; draft scans pick up changes automatically.">
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
            {errorCount > 0 && (
              <Alert tone="error" live title="Not saved">
                {errorCount === 1 ? 'One field needs attention.' : `${errorCount} fields need attention.`}
              </Alert>
            )}
            {err && (
              <Alert tone="error" live title="Not saved">
                {err}
              </Alert>
            )}
            <Button type="submit" size="lg" className="w-full" loading={busy}>
              {customerId ? 'Save changes' : 'Create organisation'}
            </Button>
            {returnTo && (
              <LinkButton to={returnTo} variant="secondary" className="w-full">
                Back to the scan without saving
              </LinkButton>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
