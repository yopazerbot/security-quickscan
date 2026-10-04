import type { SecretState, SettingSource, TestResult } from '@qs/shared';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { useToast } from '../../components/feedback';
import { PasswordInput } from '../../components/password-input';
import { isReauthCancelled, useReauth } from '../../components/reauth';
import { Badge, Button, CopyButton, Field, Input } from '../../components/ui';
import { ApiError } from '../../lib/api';

/** Query keys of the admin settings. Never put secret values in a query key. */
export const SETTINGS_KEYS = {
  auth: ['admin-settings', 'auth'],
  scanner: ['admin-settings', 'scanner'],
  general: ['admin-settings', 'general'],
} as const;

export function SourceBadge({ source }: { source: SettingSource }) {
  if (source !== 'env') return null;
  return (
    <Badge className="bg-slate-100 normal-case tracking-normal text-slate-700 ring-1 ring-slate-200">
      <span title="This value comes from an environment variable on the server. Saving it here moves it into the app settings.">From environment</span>
    </Badge>
  );
}

/** Text from a nullable setting for an input. */
export const text = (v: string | null | undefined) => v ?? '';
/** An input value for the API: trimmed, empty becomes null. */
export const orNull = (v: string) => (v.trim() ? v.trim() : null);

/** "…abcd" whether or not the server already added the ellipsis. */
const hintText = (hint: string | null) => (hint ? (hint.startsWith('…') ? hint : `…${hint}`) : '');

/**
 * Write-only secret. The stored value is never shown or prefilled, only whether one is set and its last characters.
 * `value`: undefined keeps the stored secret, '' clears it, any other string replaces it.
 */
export function SecretField({
  label,
  state,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  state: SecretState;
  value: string | undefined;
  onChange(v: string | undefined): void;
  hint?: ReactNode;
  error?: string;
}) {
  const labelId = useId();
  if (state.set && value === undefined)
    return (
      <div role="group" aria-labelledby={labelId}>
        <div id={labelId} className="mb-1.5 text-sm font-medium text-slate-700">
          {label}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 ring-1 ring-slate-200">
          <span className="text-sm text-slate-700">
            Set <span className="font-mono text-xs text-slate-500">({hintText(state.hint)})</span>
          </span>
          <SourceBadge source={state.source} />
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => onChange(REPLACING)}>
              Replace
            </Button>
            {state.source === 'app' && (
              <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" onClick={() => onChange('')}>
                Clear
              </Button>
            )}
          </span>
        </div>
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </div>
    );
  if (state.set && value === '')
    return (
      <div role="group" aria-labelledby={labelId}>
        <div id={labelId} className="mb-1.5 text-sm font-medium text-slate-700">
          {label}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 ring-1 ring-amber-200">
          <span className="text-sm text-amber-900">Removed when you save.</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChange(undefined)}>
            Undo
          </Button>
        </div>
      </div>
    );
  const editing = value === REPLACING ? '' : (value ?? '');
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PasswordInput
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            maxLength={500}
            autoFocus={state.set}
            placeholder={state.set ? 'New value' : 'Not set'}
            value={editing}
            onChange={(e) => onChange(e.target.value || (state.set ? REPLACING : undefined))}
          />
        </div>
        {state.set && (
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Cancel
          </Button>
        )}
      </div>
    </Field>
  );
}

/** Marker for "replace was clicked but nothing typed yet": treated as keep the stored secret when saving. */
export const REPLACING = '\u0000replace';

/** The secret to send: undefined keeps the stored one, '' clears it, otherwise the new value. */
export const secretInput = (v: string | undefined) => (v === undefined || v === REPLACING ? undefined : v);

/** A value the admin copies into another system (redirect URI, ARN). */
export function CopyField({ label, value, hint }: { label: string; value: string | null; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-1">
        <Input readOnly value={value ?? 'Not available yet'} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        {value && <CopyButton value={value} ariaLabel={`Copy ${label.toLowerCase()}`} />}
      </div>
    </Field>
  );
}

export function TestResultView({ result }: { result: TestResult }) {
  return (
    <div role="status" className={result.ok ? 'flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200' : 'flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200'}>
      {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <span className="break-words">{result.message}</span>
    </div>
  );
}

/**
 * Runs a settings save: asks to confirm the identity when the server wants a recent sign-in, shows the server message
 * (lockout guards, validation) inline, and toasts success.
 */
export function useSaver() {
  const { withReauth } = useReauth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = useCallback(
    async (fn: () => Promise<unknown>, success?: string, opts: { quietCodes?: string[] } = {}): Promise<{ ok: boolean; code?: string }> => {
      setBusy(true);
      setError(null);
      setFields({});
      try {
        await withReauth(fn);
        if (success) toast.success(success);
        return { ok: true };
      } catch (e) {
        if (isReauthCancelled(e)) return { ok: false };
        const code = e instanceof ApiError ? e.code : undefined;
        // Codes the caller handles itself (e.g. a confirmation dialog) are not shown as an error.
        if (code && opts.quietCodes?.includes(code)) return { ok: false, code };
        if (e instanceof ApiError && e.fields) setFields(e.fields);
        setError(e instanceof Error ? e.message : 'The settings could not be saved.');
        return { ok: false, code };
      } finally {
        setBusy(false);
      }
    },
    [withReauth, toast],
  );
  return { run, busy, error, fields, clearError: () => setError(null) };
}

/** A setting row: title, description and a switch on the right. */
export function ToggleRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        {description && <div className="mt-0.5 text-sm text-slate-500">{description}</div>}
      </div>
      <div className="pt-0.5">{children}</div>
    </div>
  );
}
