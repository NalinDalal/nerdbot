/** Odysseus-style chat workspace binding for Nerdbot.
 *  Selected workspace is chat-scoped state persisted in localStorage and sent
 *  with chat requests. Server remains authoritative for vetting/confinement.
 */

import { api } from "./api";

export const WORKSPACE_STORAGE_KEY = "nerdbot.chat.workspace";

type WorkspaceListener = (path: string) => void;
const listeners = new Set<WorkspaceListener>();

function emit(path: string) {
  for (const l of [...listeners]) l(path);
}

export function getWorkspace(): string {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setWorkspace(path: string): string {
  const next = (path || "").trim();
  try {
    if (next) localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
    else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emit(next);
  return next;
}

export function clearWorkspace(): string {
  return setWorkspace("");
}

export function subscribeWorkspace(listener: WorkspaceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function basename(path: string): string {
  const p = (path || "").replace(/[\\/]+$/, "");
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export async function vetAndSetWorkspace(path: string): Promise<{ ok: boolean; path: string | null }> {
  try {
    const res = await api.vetWorkspace(path);
    if (res.ok && res.path) {
      setWorkspace(res.path);
      return { ok: true, path: res.path };
    }
    return { ok: false, path: null };
  } catch {
    return { ok: false, path: null };
  }
}

export async function loadDefaultWorkspace(): Promise<{ ok: boolean; path: string | null }> {
  const current = getWorkspace();
  if (current) {
    const vetted = await vetAndSetWorkspace(current);
    if (vetted.ok) return vetted;
    clearWorkspace();
  }
  try {
    const res = await api.defaultWorkspace();
    if (res.ok && res.path) {
      const vetted = await vetAndSetWorkspace(res.path);
      if (vetted.ok) return vetted;
    }
  } catch {
    /* ignore */
  }
  return { ok: false, path: null };
}

export async function initWorkspace(): Promise<{ ok: boolean; path: string | null }> {
  return loadDefaultWorkspace();
}
