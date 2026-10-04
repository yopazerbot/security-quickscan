import { customerInputSchema } from '@qs/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useToast } from '../components/feedback';
import { Alert, Button, Card, ErrorState, Field, Input, LinkButton, PageHeader, PageLoader } from '../components/ui';
import { ApiError, get, post, put } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { clearDraft, loadDraft, usePersistDraft } from '../lib/drafts';
import { useDocumentTitle } from '../lib/use-document-title';

interface Draft {
  name: string;
}

const NAME_ID = 'organisation-name';

/** Readable message for the name field, instead of the schema's technical wording. */
const nameMessage = (tooBig: boolean) => (tooBig ? 'Use at most 200 characters.' : 'Enter the organisation name.');

/** Server validation errors arrive as fields or as "field: message; field: message". Only the name is a form field. */
function serverNameError(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  if (e.fields) return e.fields.name ?? null;
  const part = e.message.split(';').find((p) => p.split(':')[0]?.trim() === 'name');
  return part ? nameMessage(/too big|at most/i.test(part)) : null;
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
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const loadedKey = useRef<string | null>(null);
  useDocumentTitle(customerId ? `Edit ${existing.data?.name ?? 'organisation'}` : 'New organisation');

  // The saved value the form starts from: the organisation record, or empty for a new one.
  const baseline = useMemo<Draft | null>(() => {
    if (!customerId) return { name: '' };
    const c = existing.data;
    return c ? { name: c.name } : null;
  }, [customerId, existing.data]);
  // Unsaved input survives an expired session in this tab (per user and organisation; no secrets in this form).
  const draftKey = me ? `${me.user.id}:organisation:${customerId ?? 'new'}` : null;
  const current = useMemo<Draft>(() => ({ name }), [name]);
  const dirty = Boolean(baseline) && loadedKey.current === draftKey && JSON.stringify(current) !== JSON.stringify(baseline);
  usePersistDraft(baseline && loadedKey.current === draftKey ? draftKey : null, current, dirty);

  // Fill the form once per organisation: from a stored draft when there is one, otherwise from the record.
  useEffect(() => {
    if (!baseline || !draftKey || loadedKey.current === draftKey) return;
    loadedKey.current = draftKey;
    const draft = loadDraft<Partial<Draft> & { form?: { name?: string } }>(draftKey);
    // Drafts saved by the earlier, longer form keep the name under `form`.
    const draftName = typeof draft?.name === 'string' ? draft.name : draft?.form?.name;
    if (typeof draftName === 'string' && draftName !== baseline.name) {
      setName(draftName);
      setRestored(true);
    } else {
      setName(baseline.name);
    }
  }, [baseline, draftKey]);

  if (customerId && existing.isError) return <ErrorState error={existing.error} onRetry={() => existing.refetch()} />;
  if (customerId && existing.isLoading) return <PageLoader />;
  // View-only access: nothing to edit here.
  if (customerId && existing.data?.myAccess === 'view') return <Navigate to={`/organisations/${customerId}`} replace />;
  // Viewers cannot create organisations.
  if (!customerId && me && !can.write) return <Navigate to="/organisations" replace />;

  const discardRestored = () => {
    if (draftKey) clearDraft(draftKey);
    if (baseline) setName(baseline.name);
    setRestored(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const parsed = customerInputSchema.safeParse({ name });
    if (!parsed.success) {
      setNameError(nameMessage(parsed.error.issues.some((i) => i.code === 'too_big')));
      document.getElementById(NAME_ID)?.focus();
      return;
    }
    setNameError(null);
    setBusy(true);
    try {
      const body = parsed.data;
      const c = customerId ? await put<{ id: string }>(`/api/customers/${customerId}`, body) : await post<{ id: string }>('/api/customers', body);
      if (draftKey) clearDraft(draftKey);
      loadedKey.current = null;
      await qc.invalidateQueries({ queryKey: ['customers'] });
      await qc.invalidateQueries({ queryKey: ['customer', c.id] });
      toast.success(customerId ? 'Organisation saved.' : 'Organisation created.');
      nav(returnTo ?? `/organisations/${c.id}`);
    } catch (e) {
      const fieldErr = serverNameError(e);
      if (fieldErr) {
        setNameError(fieldErr);
        document.getElementById(NAME_ID)?.focus();
      } else {
        // Shown once, next to the save button (no extra toast).
        setErr(e instanceof Error ? e.message : 'The organisation could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <PageHeader
        crumbs={
          <Link to="/organisations" className="hover:text-slate-700">
            Organisations
          </Link>
        }
        title={customerId ? `Edit ${existing.data?.name}` : 'New organisation'}
        subtitle="Every scan runs all best-practice checks for the systems in scope. Mark findings that do not apply afterwards."
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
      <div className="max-w-xl space-y-4">
        <Card title="Organisation">
          <Field id={NAME_ID} label="Organisation name" required error={nameError ?? undefined}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              maxLength={200}
              autoFocus={!restored}
            />
          </Field>
        </Card>
        {err && (
          <Alert tone="error" live title="Not saved">
            {err}
          </Alert>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" size="lg" loading={busy}>
            {customerId ? 'Save changes' : 'Create organisation'}
          </Button>
          {returnTo && (
            <LinkButton to={returnTo} variant="secondary" size="lg">
              Back to the scan without saving
            </LinkButton>
          )}
        </div>
      </div>
    </form>
  );
}
