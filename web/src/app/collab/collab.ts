// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Tab = components['schemas']['Tab'];
export type TabInput = components['schemas']['TabInput'];
export type Canvas = components['schemas']['Canvas'];
export type ListColumn = components['schemas']['ListColumn'];
export type ListInput = components['schemas']['ListInput'];
export type ListItem = components['schemas']['ListItem'];
export type ListValues = components['schemas']['ListValues'];
export type ItemList = components['schemas']['ItemList'];
export type AssignedItem = components['schemas']['AssignedItem'];

/** The values of a status column, in order. */
export const STATUSES = ['todo', 'doing', 'done'] as const;

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- tabs ------------------------------------------------------------------------

export const tabsQuery = (channelId: string) =>
  queryOptions({
    queryKey: ['tabs', channelId],
    queryFn: () => apiFetch<{ tabs: Tab[] }>(`/api/channels/${channelId}/tabs`).then((r) => r.tabs),
  });

export const createTab = (channelId: string, input: TabInput) =>
  apiFetch<Tab>(`/api/channels/${channelId}/tabs`, json(input));
export const updateTab = (
  id: string,
  change: { title?: string; url?: string; position?: number },
) => apiFetch<Tab>(`/api/tabs/${id}`, json(change, 'PATCH'));
export const deleteTab = (id: string) => apiFetch<void>(`/api/tabs/${id}`, { method: 'DELETE' });

// --- canvases ----------------------------------------------------------------------

export const canvasQuery = (id: string) =>
  queryOptions({
    queryKey: ['canvas', id],
    queryFn: () => apiFetch<Canvas>(`/api/canvases/${id}`),
  });

export const startEditing = (id: string) =>
  apiFetch<Canvas>(`/api/canvases/${id}/editing`, { method: 'POST' });
export const stopEditing = (id: string) =>
  apiFetch<void>(`/api/canvases/${id}/editing`, { method: 'DELETE' });
export const saveCanvas = (id: string, body: string, version: number) =>
  apiFetch<Canvas>(`/api/canvases/${id}`, json({ body, version }, 'PUT'));

// --- lists -------------------------------------------------------------------------

export const listQuery = (id: string) =>
  queryOptions({
    queryKey: ['list', id],
    queryFn: () => apiFetch<ItemList>(`/api/lists/${id}`),
  });

export const updateList = (id: string, input: ListInput) =>
  apiFetch<ItemList>(`/api/lists/${id}`, json(input, 'PUT'));
export const createItem = (listId: string, title: string, values: ListValues = {}) =>
  apiFetch<ListItem>(`/api/lists/${listId}/items`, json({ title, values }));
export const updateItem = (
  id: string,
  change: { title?: string; values?: ListValues; before?: string; to_end?: boolean },
) => apiFetch<ListItem>(`/api/list-items/${id}`, json(change, 'PATCH'));
export const deleteItem = (id: string) =>
  apiFetch<void>(`/api/list-items/${id}`, { method: 'DELETE' });

export const assignedQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['assigned', workspaceId],
    queryFn: () =>
      apiFetch<{ items: AssignedItem[] }>(`/api/workspaces/${workspaceId}/assigned-items`).then(
        (r) => r.items,
      ),
    enabled: !!workspaceId,
  });

/** Puts a row into a list as cached (a change of one's own, before the event). */
export function applyItem(queryClient: QueryClient, item: ListItem) {
  queryClient.setQueryData<ItemList>(['list', item.list_id], (l) =>
    l ? { ...l, items: l.items.map((i) => (i.id === item.id ? item : i)) } : l,
  );
}

// --- realtime ------------------------------------------------------------------------

/** Applies tabs.changed, canvas.updated and list.changed. */
export function applyCollabEvent(queryClient: QueryClient, type: string, data: unknown) {
  switch (type) {
    case 'tabs.changed': {
      const { channel_id } = data as { channel_id: string };
      void queryClient.invalidateQueries({ queryKey: ['tabs', channel_id] });
      return true;
    }
    case 'canvas.updated': {
      const { canvas } = data as { canvas: Canvas };
      // can_edit is the reader's own: keep it.
      queryClient.setQueryData<Canvas>(['canvas', canvas.id], (old) =>
        old ? { ...canvas, can_edit: old.can_edit } : old,
      );
      return true;
    }
    case 'list.changed': {
      const { list_id } = data as { list_id: string };
      void queryClient.invalidateQueries({ queryKey: ['list', list_id] });
      void queryClient.invalidateQueries({ queryKey: ['assigned'] });
      return true;
    }
  }
  return false;
}
