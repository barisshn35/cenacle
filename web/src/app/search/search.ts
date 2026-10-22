// SPDX-License-Identifier: Apache-2.0
import { infiniteQueryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type SearchMessage = components['schemas']['SearchMessage'];
export type SearchFile = components['schemas']['SearchFile'];

export interface MessageFilters {
  workspaceId?: string;
  channelId?: string;
  from?: string;
  /** yyyy-mm-dd, from the start of that day. */
  after?: string;
  /** yyyy-mm-dd, to the end of that day. */
  until?: string;
  has?: 'file' | 'link';
}

const PAGE = 20;

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();

export const searchMessagesQuery = (q: string, f: MessageFilters) =>
  infiniteQueryOptions({
    queryKey: ['search', 'messages', q, f],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ q, limit: String(PAGE) });
      if (f.workspaceId) p.set('workspace_id', f.workspaceId);
      if (f.channelId) p.set('channel_id', f.channelId);
      if (f.from) p.set('from', f.from);
      if (f.after) p.set('after', dayStart(f.after));
      if (f.until) p.set('until', dayEnd(f.until));
      if (f.has) p.set('has', f.has);
      if (pageParam) p.set('before', pageParam);
      return apiFetch<{ results: SearchMessage[]; has_more: boolean }>(
        `/api/search/messages?${p.toString()}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.results.at(-1)?.id : undefined),
    enabled: q.trim() !== '',
    staleTime: 30_000,
  });

export const searchFilesQuery = (q: string, workspaceId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: ['search', 'files', q, workspaceId],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ q, limit: String(PAGE) });
      if (workspaceId) p.set('workspace_id', workspaceId);
      if (pageParam) p.set('before', pageParam);
      return apiFetch<{ results: SearchFile[]; has_more: boolean }>(
        `/api/search/files?${p.toString()}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more ? page.results.at(-1)?.id : undefined),
    enabled: q.trim() !== '',
    staleTime: 30_000,
  });

/** Lowercase, without accents: how the server compares words. */
export const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');

/** The words a query looks for (not the ones it leaves out). */
export function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-'))
    .map((w) => fold(w.replace(/[^\p{L}\p{N}_]/gu, '')))
    .filter(Boolean);
}

/** Splits text into parts, marking words that begin with a search term. */
export function markTerms(text: string, terms: string[]): { text: string; mark: boolean }[] {
  if (terms.length === 0) return [{ text, mark: false }];
  return text
    .split(/([\p{L}\p{N}_]+)/u)
    .filter((s) => s !== '')
    .map((s) => ({ text: s, mark: terms.some((t) => fold(s).startsWith(t)) }));
}

/** A message body as one line of plain text. */
export function plainText(body: string, n = 280): string {
  const text = body
    .replace(/<@[0-9a-f-]{36}>/g, '@…')
    .replace(/[*_~`>#]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}
