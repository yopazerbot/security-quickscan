let csrfToken = '';

export function setCsrfToken(t: string) {
  csrfToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T = any>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('qs:unauthorized'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
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
