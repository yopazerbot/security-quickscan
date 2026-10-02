import type { CheckOutcome, ResourceRef } from '@qs/shared';

export class CheckError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Raised when the API says the feature/licence is not available: reported as "not applicable". */
export class NotApplicable extends Error {}

export const pass = (summary: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ status: 'pass', summary, ...extra });
export const fail = (summary: string, resources: ResourceRef[] = [], evidence?: Record<string, unknown>): CheckOutcome => ({
  status: 'fail',
  summary,
  resources: resources.slice(0, 500),
  evidence,
});
export const warn = (summary: string, resources: ResourceRef[] = [], evidence?: Record<string, unknown>): CheckOutcome => ({
  status: 'warn',
  summary,
  resources: resources.slice(0, 500),
  evidence,
});
export const na = (summary: string): CheckOutcome => ({ status: 'na', summary });

/** fail if any resources, otherwise pass. */
export function failIfAny(resources: ResourceRef[], failMsg: (n: number) => string, passMsg: string, level: 'fail' | 'warn' = 'fail'): CheckOutcome {
  if (resources.length === 0) return pass(passMsg);
  return level === 'fail' ? fail(failMsg(resources.length), resources) : warn(failMsg(resources.length), resources);
}

export class Memo {
  private store = new Map<string, Promise<unknown>>();
  get<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.store.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.store.set(key, p);
      // Do not cache failures forever; let the next caller retry.
      p.catch(() => this.store.delete(key));
    }
    return p;
  }
}

/** Run async tasks with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      signal?.throwIfAborted();
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Max pages followed by any paginated API call (stops runaway or looping nextLink chains). */
export const MAX_PAGES = 200;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new CheckError(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

export interface JsonRequest {
  url: string;
  token: string;
  method?: string;
  headers?: Record<string, string>;
  /** Hosts allowed for this request (defence in depth against SSRF via pagination links). */
  allowedHosts: string[];
  /** Aborted when the check times out or the scan stops. */
  signal?: AbortSignal;
}

export interface JsonResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** fetch + JSON with retry on 429/5xx, timeout and host allow-listing. */
export async function fetchJson<T = any>(req: JsonRequest, attempt = 0): Promise<JsonResponse<T>> {
  const u = new URL(req.url);
  if (u.protocol !== 'https:' || !req.allowedHosts.includes(u.hostname)) {
    throw new CheckError(`Refusing request to unexpected host ${u.hostname}`);
  }
  const res = await fetch(u, {
    method: req.method ?? 'GET',
    headers: { Authorization: `Bearer ${req.token}`, Accept: 'application/json', ...req.headers },
    signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt);
    return fetchJson(req, attempt + 1);
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, headers: res.headers };
}
