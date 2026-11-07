// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiFetch, type components } from '@cenacle/core/api';
import { isConversation, type Category, type Channel } from '../chat/data';

export type SidebarLayout = components['schemas']['SidebarLayout'];

/** Keys of the sections every sidebar has (categories and own sections go by id). */
export const FAVORITES = 'favorites';
export const CHANNELS = 'channels';
export const DIRECT = 'direct';
export const UNREADS = 'unreads';

export const emptyLayout = (): SidebarLayout => ({
  order: [],
  sections: [],
  placements: {},
  group_unreads: false,
  collapsed: [],
});

export const sidebarQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['sidebar', workspaceId],
    queryFn: () => apiFetch<SidebarLayout>(`/api/workspaces/${workspaceId}/sidebar`),
    enabled: !!workspaceId,
    staleTime: Infinity,
  });

export interface Section {
  key: string;
  kind: 'unreads' | 'favorites' | 'channels' | 'category' | 'own' | 'direct';
  /** The name of a category or of one's own section. */
  name?: string;
  channels: Channel[];
}

/** Whether a channel counts as unread in the sidebar (muted ones only for mentions). */
export const isUnread = (c: Channel, muted: Set<string>) =>
  c.unread_count > 0 && (!muted.has(c.id) || c.mention_count > 0);

/** The section a channel goes to when the person did not place it. */
export function homeOf(c: Channel, categories: Set<string>): string {
  if (isConversation(c)) return DIRECT;
  return c.category_id && categories.has(c.category_id) ? c.category_id : CHANNELS;
}

/**
 * The sections of a workspace's sidebar from the top, with their channels:
 * unread ones first when gathered, then the sections in the person's order
 * (the ones not ordered follow in their usual order). Favorites shows once it
 * has something; categories when they do; one's own sections always.
 */
export function arrange(
  layout: SidebarLayout,
  channels: Channel[],
  categories: Category[],
  muted: Set<string>,
  /** Show categories with no channel yet (to those who organize them). */
  emptyCategories = false,
): Section[] {
  const categoryIds = new Set(categories.map((c) => c.id));
  const own = new Set(layout.sections.map((s) => s.id));
  const sections = new Map<string, Section>();
  sections.set(FAVORITES, { key: FAVORITES, kind: 'favorites', channels: [] });
  for (const s of layout.sections) {
    sections.set(s.id, { key: s.id, kind: 'own', name: s.name, channels: [] });
  }
  sections.set(CHANNELS, { key: CHANNELS, kind: 'channels', channels: [] });
  for (const c of categories) {
    sections.set(c.id, { key: c.id, kind: 'category', name: c.name, channels: [] });
  }
  sections.set(DIRECT, { key: DIRECT, kind: 'direct', channels: [] });

  const unreads: Section = { key: UNREADS, kind: 'unreads', channels: [] };
  for (const c of channels) {
    if (layout.group_unreads && isUnread(c, muted)) {
      unreads.channels.push(c);
      continue;
    }
    const placed = layout.placements[c.id];
    const key =
      placed && (placed === FAVORITES || own.has(placed)) ? placed : homeOf(c, categoryIds);
    sections.get(key)!.channels.push(c);
  }
  // Conversations: the unread ones first, then by name.
  const direct = sections.get(DIRECT)!;
  direct.channels.sort((a, b) => b.unread_count - a.unread_count || a.name.localeCompare(b.name));

  const order = [
    ...layout.order.filter((k) => sections.has(k)),
    ...[...sections.keys()].filter((k) => !layout.order.includes(k)),
  ];
  const shown = order
    .map((k) => sections.get(k)!)
    .filter(
      (s) =>
        (s.kind !== 'favorites' && s.kind !== 'category') ||
        s.channels.length > 0 ||
        (s.kind === 'category' && emptyCategories),
    );
  return unreads.channels.length > 0 ? [unreads, ...shown] : shown;
}

/** The order of all sections as shown, for moving one among them. */
export function fullOrder(sections: Section[]): string[] {
  return sections.filter((s) => s.kind !== 'unreads').map((s) => s.key);
}

/** Moves a section one place up or down (or before another section). */
export function moveSection(order: string[], key: string, to: number): string[] {
  const rest = order.filter((k) => k !== key);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/**
 * The person's arrangement of the active workspace's sidebar, and a way to
 * change it: the change shows at once and is saved; it is undone if saving fails.
 */
export function useSidebarLayout(workspaceId: string | undefined) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery(sidebarQuery(workspaceId));
  const key = sidebarQuery(workspaceId).queryKey;
  const save = useMutation({
    mutationFn: (next: SidebarLayout) =>
      apiFetch<SidebarLayout>(`/api/workspaces/${workspaceId}/sidebar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<SidebarLayout>(key);
      queryClient.setQueryData(key, next);
      return { before };
    },
    onSuccess: (kept) => queryClient.setQueryData(key, kept),
    onError: (_err, _next, ctx) => {
      queryClient.setQueryData(key, ctx?.before);
      toast.error(t('sidebar.saveFailed'));
    },
  });
  const layout = query.data ?? emptyLayout();
  const update = (change: (l: SidebarLayout) => SidebarLayout) =>
    save.mutate(change(queryClient.getQueryData<SidebarLayout>(key) ?? emptyLayout()));
  return { layout, update, loaded: query.isSuccess };
}

/** Places a channel in a section; its home section takes it back. */
export function place(l: SidebarLayout, channelId: string, section: string | null): SidebarLayout {
  const placements = { ...l.placements };
  if (section === null) delete placements[channelId];
  else placements[channelId] = section;
  return { ...l, placements };
}

/** Folds a section away or opens it. */
export function toggleCollapsed(l: SidebarLayout, key: string): SidebarLayout {
  return {
    ...l,
    collapsed: l.collapsed.includes(key)
      ? l.collapsed.filter((k) => k !== key)
      : [...l.collapsed, key],
  };
}

/** A new section of one's own, shown below Favorites. */
export function addSection(l: SidebarLayout, sections: Section[], name: string, id: string) {
  const order = fullOrder(sections);
  const at = order.indexOf(FAVORITES) + 1;
  return {
    ...l,
    sections: [...l.sections, { id, name }],
    order: moveSection(order, id, at),
  };
}

/** Removes one's own section; its channels go back to their home sections. */
export function removeSection(l: SidebarLayout, id: string): SidebarLayout {
  return {
    ...l,
    sections: l.sections.filter((s) => s.id !== id),
    order: l.order.filter((k) => k !== id),
    collapsed: l.collapsed.filter((k) => k !== id),
    placements: Object.fromEntries(Object.entries(l.placements).filter(([, s]) => s !== id)),
  };
}

export function renameSection(l: SidebarLayout, id: string, name: string): SidebarLayout {
  return { ...l, sections: l.sections.map((s) => (s.id === id ? { ...s, name } : s)) };
}
