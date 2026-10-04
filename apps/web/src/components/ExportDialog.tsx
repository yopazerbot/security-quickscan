import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { postForDownload } from '../lib/api';
import { generatePassphrase } from '../lib/password';
import { useToast } from './feedback';
import { PasswordInput } from './password-input';
import { Alert, Button, CopyButton, Field, Modal } from './ui';

/** Same limits as the server (portability/format.ts). */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 256;

/**
 * Exports one organisation (or everything the user can see) to an encrypted .qsx file. The passphrase is required,
 * is sent in the request body only and is never stored: without it the file cannot be opened.
 */
export function ExportDialog({ organisation, onClose }: { organisation?: { id: string; name: string }; onClose(): void }) {
  const toast = useToast();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ pass?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);
  const what = organisation ? organisation.name : 'all organisations';

  const generate = () => {
    const p = generatePassphrase();
    setGenerated(p);
    setPass(p);
    setConfirm(p);
    setFieldErr({});
  };

  const submit = async () => {
    const fe: typeof fieldErr = {};
    if (pass.length < PASSPHRASE_MIN) fe.pass = `Use at least ${PASSPHRASE_MIN} characters.`;
    else if (pass.length > PASSPHRASE_MAX) fe.pass = `Use at most ${PASSPHRASE_MAX} characters.`;
    if (!fe.pass && confirm !== pass) fe.confirm = 'The passphrases do not match.';
    setFieldErr(fe);
    if (fe.pass || fe.confirm) return;
    setBusy(true);
    setErr(null);
    try {
      const name = await postForDownload('/api/export', organisation ? { organisationId: organisation.id, passphrase: pass } : { all: true, passphrase: pass });
      toast.success(`Saved ${name}. Keep the passphrase somewhere safe: the file cannot be opened without it.`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      busy={busy}
      onClose={onClose}
      title={organisation ? `Export ${organisation.name}` : 'Export all organisations'}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Export
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-slate-600">
          Saves the complete scan history of {what} to an encrypted file: every finished scan with its results, the scanned systems and environments, and triage decisions. Import
          it into this or another installation to keep comparing new scans with it. Stored credentials are never included.
        </p>
        <Alert tone="warn">
          The file contains security findings. It is encrypted with the passphrase below and cannot be opened without it: there is no way to recover a lost passphrase.
        </Alert>
        <Field label="Passphrase" required error={fieldErr.pass} hint={`At least ${PASSPHRASE_MIN} characters and not a common password.`}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <PasswordInput
                autoComplete="new-password"
                maxLength={PASSPHRASE_MAX}
                value={pass}
                onChange={(e) => {
                  setPass(e.target.value);
                  setGenerated(null);
                }}
              />
            </div>
            <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={generate}>
              Generate
            </Button>
          </div>
        </Field>
        <Field label="Repeat the passphrase" required error={fieldErr.confirm}>
          <PasswordInput autoComplete="new-password" maxLength={PASSPHRASE_MAX} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {generated && (
          <div className="space-y-2 text-sm text-slate-600" role="status">
            <p>Generated passphrase. Copy it to your password manager now: it is not shown again.</p>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 px-3 py-2">
              <code className="break-all font-mono text-sm text-slate-100">{generated}</code>
              <span className="shrink-0 rounded-md bg-white/90">
                <CopyButton value={generated} ariaLabel="Copy the passphrase" />
              </span>
            </div>
          </div>
        )}
        {err && (
          <Alert tone="error" live>
            {err}
          </Alert>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
