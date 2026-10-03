import { useEffect, useRef } from 'react';

/**
 * Unsaved form input kept in sessionStorage (this tab only), so a session that expires while someone is typing
 * does not lose their work: the form restores it after signing in again. Never store secrets here.
 */
const PREFIX = 'qs_draft:';

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, value: unknown) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full */
  }
}

export function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

/** On sign-out: drop every stored draft in this tab. */
export function clearAllDrafts() {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Keeps `value` stored under `key` while `dirty` is true and removes it when the form is clean again.
 * `key` null disables storage (e.g. while the form is still loading).
 */
export function usePersistDraft(key: string | null, value: unknown, dirty: boolean) {
  const latest = useRef({ key, value, dirty });
  latest.current = { key, value, dirty };
  useEffect(() => {
    if (!key) return;
    if (dirty) saveDraft(key, value);
    else clearDraft(key);
  }, [key, value, dirty]);
  // Write immediately when asked (before signing in again) and when leaving the tab.
  useEffect(() => {
    const flush = () => {
      const l = latest.current;
      if (l.key && l.dirty) saveDraft(l.key, l.value);
    };
    window.addEventListener('qs:save-drafts', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('qs:save-drafts', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
}
