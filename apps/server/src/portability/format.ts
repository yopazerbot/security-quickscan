/**
 * Portable export file (.qsx): the complete scan history of one or more organisations, encrypted with a passphrase.
 * The format is documented in docs/EXPORT-FORMAT.md; keep both in sync.
 *
 * Envelope (JSON): { format, version, createdAt, kdf, cipher, data }. The key is derived from the passphrase with
 * Argon2id; data is AES-256-GCM over the gzipped payload JSON, with the canonical JSON of the header (everything but
 * data) as additional authenticated data. A wrong passphrase and any change to the file fail the same way.
 */
import { hashRaw, type Algorithm } from '@node-rs/argon2';
import { PROVIDERS } from '@qs/shared';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { z } from 'zod';
import { HttpError } from '../context.js';

export const EXPORT_FORMAT = 'security-quickscan-export';
/** Envelope version: the encryption layer. */
export const ENVELOPE_VERSION = 1;
/** Payload schema version: the data inside. */
export const SCHEMA_VERSION = 1;
export const EXPORT_EXTENSION = 'qsx';

/** Largest decompressed payload accepted (protects against decompression bombs). */
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Largest .qsx file accepted by the import endpoint (the request carries it as base64). */
export const MAX_FILE_BYTES = 48 * 1024 * 1024;

export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 256;

/** The only message for a wrong passphrase or a modified file: the two cannot be told apart. */
export const DECRYPT_FAILED = 'The passphrase is wrong or the file was modified';
const TOO_NEW = 'This file was made by a newer version of Security QuickScan. Update this installation first.';
const NOT_AN_EXPORT = 'This is not a Security QuickScan export file';

const KDF = { alg: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 } as const;
/** Argon2id; a const enum in the typings, which isolated modules cannot reference. */
const ARGON2ID = 2 as Algorithm;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ---------- payload schema (version 1) ----------

const isoDate = z.iso.datetime({ offset: true });
const isoDateOrNull = isoDate.nullable();
const jsonObject = z.record(z.string(), z.unknown());
const checkId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid check id');
const email = z.string().max(320);

const systemSchema = z.object({
  exportId: z.uuid(),
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(200),
  environment: z.string().max(200).nullable(),
  config: jsonObject,
  startedConfig: jsonObject.nullable(),
  connectionOk: z.boolean().nullable(),
  connectionMessage: z.string().max(5000).nullable(),
  connectionDetails: jsonObject.nullable(),
  connectionCheckedAt: isoDateOrNull,
  createdAt: isoDate,
});

const resultSchema = z.object({
  system: z.uuid(),
  checkId,
  status: z.enum(['pending', 'running', 'pass', 'fail', 'warn', 'na', 'error']),
  summary: z.string().max(20_000),
  resources: z.array(z.unknown()).max(10_000),
  evidence: jsonObject.nullable(),
  startedAt: isoDateOrNull,
  finishedAt: isoDateOrNull,
});

const scanSchema = z
  .object({
    exportId: z.uuid(),
    name: z.string().min(1).max(200),
    status: z.enum(['completed', 'failed', 'cancelled']),
    createdAt: isoDate,
    queuedAt: isoDateOrNull,
    startedAt: isoDateOrNull,
    finishedAt: isoDateOrNull,
    score: z.number().int().min(0).max(100).nullable(),
    grade: z.string().max(5).nullable(),
    summary: jsonObject.nullable(),
    systems: z.array(systemSchema).max(200),
    results: z.array(resultSchema).max(100_000),
    excludedChecks: z.array(z.object({ checkId, reason: z.string().max(5000) })).max(2000),
  })
  .superRefine((s, ctx) => {
    const ids = new Set(s.systems.map((x) => x.exportId));
    if (ids.size !== s.systems.length) ctx.addIssue({ code: 'custom', message: 'Duplicate system id', path: ['systems'] });
    const seen = new Set<string>();
    for (const r of s.results) {
      if (!ids.has(r.system)) {
        ctx.addIssue({ code: 'custom', message: 'Result for an unknown system', path: ['results'] });
        return;
      }
      const k = `${r.system}|${r.checkId}`;
      if (seen.has(k)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate result', path: ['results'] });
        return;
      }
      seen.add(k);
    }
  });

const organisationSchema = z.object({
  exportId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  createdAt: isoDate,
  ownerEmail: email.nullable(),
  shares: z.array(z.object({ email, permission: z.enum(['view', 'edit']) })).max(1000),
  triage: z
    .array(
      z.object({
        checkId,
        systemKey: z.string().min(1).max(300),
        status: z.enum(['open', 'accepted', 'false_positive']),
        note: z.string().max(5000),
        updatedAt: isoDate,
        updatedByEmail: email.nullable(),
      }),
    )
    .max(50_000),
  scans: z.array(scanSchema).max(10_000),
});

export const MAX_ORGANISATIONS = 500;
export const MAX_SCANS = 10_000;

export const payloadSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.literal(SCHEMA_VERSION),
    appVersion: z.string().max(50),
    exportedAt: isoDate,
    exportedBy: z.object({ name: z.string().max(200), email }),
    scope: z.enum(['organisation', 'all']),
    organisations: z.array(organisationSchema).max(MAX_ORGANISATIONS),
  })
  .superRefine((p, ctx) => {
    if (p.organisations.reduce((n, o) => n + o.scans.length, 0) > MAX_SCANS) ctx.addIssue({ code: 'custom', message: `At most ${MAX_SCANS} scans per file`, path: ['organisations'] });
    if (new Set(p.organisations.map((o) => o.exportId)).size !== p.organisations.length) ctx.addIssue({ code: 'custom', message: 'Duplicate organisation id', path: ['organisations'] });
  });

export type ExportPayload = z.infer<typeof payloadSchema>;
export type ExportOrganisation = ExportPayload['organisations'][number];
export type ExportScan = ExportOrganisation['scans'][number];
export type ExportSystem = ExportScan['systems'][number];

// ---------- envelope ----------

const envelopeSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(ENVELOPE_VERSION),
  createdAt: isoDate,
  kdf: z.object({
    alg: z.literal('argon2id'),
    // Bounded so a crafted file cannot make the server spend unbounded memory or time.
    memoryKiB: z.number().int().min(19_456).max(262_144),
    iterations: z.number().int().min(2).max(10),
    parallelism: z.number().int().min(1).max(4),
    salt: z.base64().max(64),
  }),
  cipher: z.object({ alg: z.literal('aes-256-gcm'), iv: z.base64().max(32) }),
  data: z.base64(),
});
type Header = Omit<z.infer<typeof envelopeSchema>, 'data'>;

/** JSON with sorted object keys, so the header bytes used as AAD do not depend on key order in the file. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

async function deriveKey(passphrase: string, kdf: Header['kdf']): Promise<Buffer> {
  return hashRaw(passphrase.normalize('NFC'), {
    algorithm: ARGON2ID,
    memoryCost: kdf.memoryKiB,
    timeCost: kdf.iterations,
    parallelism: kdf.parallelism,
    outputLen: 32,
    salt: Buffer.from(kdf.salt, 'base64'),
  });
}

/** Encrypts already gzipped payload bytes into the .qsx envelope (returned as UTF-8 JSON bytes). */
export async function sealExport(gzipped: Buffer, passphrase: string): Promise<Buffer> {
  const header: Header = {
    format: EXPORT_FORMAT,
    version: ENVELOPE_VERSION,
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: randomBytes(16).toString('base64') },
    cipher: { alg: 'aes-256-gcm', iv: randomBytes(12).toString('base64') },
  };
  const key = await deriveKey(passphrase, header.kdf);
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'));
  cipher.setAAD(Buffer.from(canonicalJson(header), 'utf8'));
  const data = Buffer.concat([cipher.update(gzipped), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  return Buffer.from(JSON.stringify({ ...header, data: data.toString('base64') }), 'utf8');
}

/** Encrypts a payload into the .qsx envelope. */
export async function encryptExport(payload: ExportPayload, passphrase: string): Promise<Buffer> {
  return sealExport(await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8')), passphrase);
}

/**
 * Decrypts and validates a .qsx file. Throws HttpError 400 with a message meant for the user: not an export,
 * made by a newer version, wrong passphrase or modified (one message), too large, or invalid content.
 */
export async function decryptExport(file: Buffer, passphrase: string): Promise<ExportPayload> {
  let raw: unknown;
  try {
    raw = JSON.parse(file.toString('utf8'));
  } catch {
    throw new HttpError(400, NOT_AN_EXPORT);
  }
  const outer = raw as Record<string, unknown> | null;
  if (!outer || typeof outer !== 'object' || outer.format !== EXPORT_FORMAT) throw new HttpError(400, NOT_AN_EXPORT);
  if (typeof outer.version === 'number' && outer.version > ENVELOPE_VERSION) throw new HttpError(400, TOO_NEW);
  const env = envelopeSchema.safeParse(raw);
  // A header that does not validate was changed (or damaged): same answer as a failed authentication.
  if (!env.success) throw new HttpError(400, DECRYPT_FAILED);
  const { data, ...header } = env.data;
  const iv = Buffer.from(header.cipher.iv, 'base64');
  const blob = Buffer.from(data, 'base64');
  if (iv.length !== 12 || blob.length < 17 || Buffer.from(header.kdf.salt, 'base64').length < 16) throw new HttpError(400, DECRYPT_FAILED);

  const key = await deriveKey(passphrase, header.kdf);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(canonicalJson(header), 'utf8'));
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    plain = Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]);
  } catch {
    throw new HttpError(400, DECRYPT_FAILED);
  } finally {
    key.fill(0);
  }

  let json: Buffer;
  try {
    json = await gunzipAsync(plain, { maxOutputLength: MAX_PAYLOAD_BYTES });
  } catch (e: any) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw new HttpError(413, 'The export is too large to import');
    throw new HttpError(400, 'The export file is damaged');
  }
  let body: any;
  try {
    body = JSON.parse(json.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The export file is damaged');
  }
  if (body?.format !== EXPORT_FORMAT) throw new HttpError(400, NOT_AN_EXPORT);
  if (typeof body.schemaVersion === 'number' && body.schemaVersion > SCHEMA_VERSION) throw new HttpError(400, TOO_NEW);
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(400, `The export content is not valid (${first ? `${first.path.join('.') || 'file'}: ${first.message}` : 'unknown error'})`.slice(0, 500));
  }
  return parsed.data;
}

/** Remaps the system ids inside a frozen summary (controls[].checks[].systemId); unknown ids are left out of the check. */
export function remapSummarySystems(summary: Record<string, unknown> | null, map: Map<string, string>): Record<string, unknown> | null {
  if (!summary) return null;
  const controls = Array.isArray(summary.controls)
    ? summary.controls.map((c: any) =>
        c && typeof c === 'object' && Array.isArray(c.checks)
          ? {
              ...c,
              checks: c.checks.map((x: any) => {
                if (!x || typeof x !== 'object' || typeof x.systemId !== 'string') return x;
                const to = map.get(x.systemId);
                if (to) return { ...x, systemId: to };
                const { systemId: _drop, ...rest } = x;
                return rest;
              }),
            }
          : c,
      )
    : summary.controls;
  return { ...summary, controls };
}

/** File name of an export: quickscan-<organisation slug or all>-<YYYY-MM-DD>.qsx. */
export function exportFileName(label: string, at = new Date()): string {
  const slug =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'organisation';
  return `quickscan-${slug}-${at.toISOString().slice(0, 10)}.${EXPORT_EXTENSION}`;
}
