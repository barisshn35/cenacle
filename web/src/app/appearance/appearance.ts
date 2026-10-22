// SPDX-License-Identifier: Apache-2.0
import { queryOptions } from '@tanstack/react-query';
import { create } from 'zustand';
import { apiFetch, type components } from '@cenacle/core/api';
import {
  applyResolvedAppearance,
  familyOf,
  FONT_TEMPLATES,
  type ResolvedAppearance,
  type ThemePreset,
} from '@cenacle/ui/theme';
import { safeStorage } from '@cenacle/ui/lib/storage';

export type Appearance = components['schemas']['Appearance'];
export type WorkspaceAppearance = components['schemas']['WorkspaceAppearance'];
export type UserFont = components['schemas']['UserFont'];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  preset: 'workspace',
  density: 'auto',
  fonts: { template: 'workspace', text: 'inter', code: 'jetbrains-mono' },
  font_size: 14,
  line_height: 'normal',
  code: { theme: 'github', line_numbers: false, wrap: false, ligatures: true },
};

const DEFAULT_WORKSPACE: WorkspaceAppearance = { preset: 'cenacle', font_template: 'corporate' };

const json = (body: unknown, method: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const appearanceQuery = queryOptions({
  queryKey: ['me', 'appearance'],
  queryFn: () => apiFetch<Appearance>('/api/me/appearance'),
  staleTime: Infinity,
});
export const saveAppearance = (a: Appearance) =>
  apiFetch<Appearance>('/api/me/appearance', json(a, 'PUT'));

export const fontsQuery = queryOptions({
  queryKey: ['me', 'fonts'],
  queryFn: () => apiFetch<{ fonts: UserFont[] }>('/api/me/fonts').then((r) => r.fonts),
  staleTime: Infinity,
});
export const uploadFont = (name: string, file: Blob) =>
  apiFetch<UserFont>(`/api/me/fonts?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
export const deleteFont = (id: string) =>
  apiFetch<void>(`/api/me/fonts/${id}`, { method: 'DELETE' });

export const setWorkspaceAppearance = (workspaceId: string, a: WorkspaceAppearance) =>
  apiFetch<components['schemas']['Workspace']>(
    `/api/workspaces/${workspaceId}/appearance`,
    json(a, 'PUT'),
  );

/** The person's settings with the workspace's defaults where they chose those. */
export function resolveAppearance(
  a: Appearance,
  ws: WorkspaceAppearance = DEFAULT_WORKSPACE,
): ResolvedAppearance {
  const preset = (a.preset === 'workspace' ? ws.preset : a.preset) as ThemePreset;
  const template = a.fonts.template === 'workspace' ? ws.font_template : a.fonts.template;
  const fonts = template === 'custom' ? a.fonts : FONT_TEMPLATES[template];
  return {
    preset,
    textFamily: familyOf(fonts.text, 'text'),
    codeFamily: familyOf(fonts.code, 'code'),
    fontSize: a.font_size,
    lineHeight: a.line_height,
    ligatures: a.code.ligatures,
  };
}

const CACHE_KEY = 'cenacle.appearance';

/** Applies the last appearance seen on this device (before the first paint). */
export function applyCachedAppearance(): void {
  try {
    const cached = JSON.parse(safeStorage.get(CACHE_KEY) ?? 'null') as ResolvedAppearance | null;
    if (cached?.preset) applyResolvedAppearance(cached);
  } catch {
    // Nothing usable stored.
  }
}

const loadedFonts = new Set<string>();

/** Makes an uploaded font available under its family name (once). */
async function loadUserFont(id: string): Promise<void> {
  if (loadedFonts.has(id) || typeof FontFace === 'undefined') return;
  loadedFonts.add(id);
  try {
    const face = new FontFace(familyOf(`user:${id}`, 'text'), `url(/api/fonts/${id})`);
    document.fonts.add(await face.load());
  } catch {
    loadedFonts.delete(id); // the fallback fonts stay
  }
}

/** Shows an appearance and remembers it for the next start on this device. */
export function showAppearance(a: Appearance, ws?: WorkspaceAppearance): void {
  const resolved = resolveAppearance(a, ws);
  for (const id of [a.fonts.text, a.fonts.code]) {
    if (id.startsWith('user:') && a.fonts.template === 'custom') void loadUserFont(id.slice(5));
  }
  applyResolvedAppearance(resolved);
  safeStorage.set(CACHE_KEY, JSON.stringify(resolved));
  useCodeSettings.setState(a.code);
}

/** The code block settings in effect (read by every code block). */
export const useCodeSettings = create<Appearance['code']>()(() => DEFAULT_APPEARANCE.code);
