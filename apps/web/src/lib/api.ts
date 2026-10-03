let csrfToken = '';
/** Time of the last request the server saw from this tab: every API request resets the server's idle timer. */
let lastRequestAt = Date.now();

export function setCsrfToken(t: string) {
  csrfToken = t;
}

/** Shared between tabs: requests from any tab of this app keep the same session alive. */
const CONTACT_KEY = 'qs_last_contact';
let sharedWrittenAt = 0;
function noteContact() {
  lastRequestAt = Date.now();
  if (lastRequestAt - sharedWrittenAt < 10_000) return;
  sharedWrittenAt = lastRequestAt;
  try {
    localStorage.setItem(CONTACT_KEY, String(lastRequestAt));
  } catch {
    /* storage unavailable */
  }
}

/** When this browser (any tab) last talked to the server (ms since epoch). Used by the session expiry warning. */
export function lastServerContact() {
  let shared = 0;
  try {
    shared = Number(localStorage.getItem(CONTACT_KEY)) || 0;
  } catch {
    /* storage unavailable */
  }
  return Math.max(lastRequestAt, shared);
}

/** sessionStorage flag read by the login page: set when a signed-in session ended (not on a fresh visit). */
export const EXPIRED_FLAG = 'qs_expired';

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again to continue.';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Per-field messages from a validation error ({ "contactEmail": "Enter a valid email address." }). */
    public fields?: Record<string, string>,
    /** The full JSON error body, for answers that carry more than a message (e.g. ownedOrganisations on a 409). */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function markExpired() {
  try {
    sessionStorage.setItem(EXPIRED_FLAG, '1');
  } catch {
    /* storage unavailable */
  }
}

export async function api<T = any>(path: string, opts: { method?: Method; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  noteContact();
  const res = await fetch(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // A signed-in session ended (idle or absolute timeout, revoked). Sign-in endpoints answer 401 for wrong
  // credentials, so only the session check counts among the /api/auth/ paths.
  const signedIn = csrfToken !== '';
  if (res.status === 401 && signedIn && (!path.startsWith('/api/auth/') || path.startsWith('/api/auth/me'))) {
    markExpired();
    if (method === 'GET') {
      // Reads: sign out of the UI and return to the login page (with this page as the return target).
      csrfToken = '';
      window.dispatchEvent(new Event('qs:unauthorized'));
    } else {
      // Writes: keep the page and its unsaved input on screen and offer to sign in again.
      window.dispatchEvent(new Event('qs:reauth'));
      throw new ApiError(401, SESSION_EXPIRED_MESSAGE);
    }
  }
  if (!res.ok && method !== 'GET' && (res.status === 403 || res.status === 404)) {
    // Access may have been removed while the page was open (share revoked, organisation deleted): pages listen
    // for this to reload their data, which then shows a clear "no access" state.
    window.dispatchEvent(new CustomEvent('qs:access-denied', { detail: { status: res.status, path } }));
    if (res.status === 404 && (!data?.error || /^not found\.?$/i.test(data.error)))
      throw new ApiError(404, 'You no longer have access to this item, or it was deleted.');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.fields && typeof data.fields === 'object' ? data.fields : undefined, data && typeof data === 'object' ? data : undefined);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
