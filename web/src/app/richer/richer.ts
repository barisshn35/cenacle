// SPDX-License-Identifier: Apache-2.0
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';
import { addMessage, patchMessage, type Message } from '../chat/data';

export type LinkPreview = components['schemas']['LinkPreview'];
export type ForwardInfo = components['schemas']['ForwardInfo'];
export type CustomEmoji = components['schemas']['CustomEmoji'];
export type Sticker = components['schemas']['Sticker'];

const messageUrl = (m: Pick<Message, 'id' | 'channel_id'>) =>
  `/api/channels/${m.channel_id}/messages/${m.id}`;

// --- link previews -------------------------------------------------------------

export const hideLinkPreview = (m: Message) =>
  apiFetch<void>(`${messageUrl(m)}/link-preview`, { method: 'DELETE' });

/** message.preview: a message's link preview arrived or was removed. */
export function applyLinkPreview(
  queryClient: QueryClient,
  ev: { channel_id: string; message_id: string; link_preview: LinkPreview | null },
) {
  patchMessage(queryClient, ev.channel_id, ev.message_id, (m) => ({
    ...m,
    link_preview: ev.link_preview ?? undefined,
  }));
}

// --- forwarding ------------------------------------------------------------------

export const forwardMessage = (m: Message, channelId: string, comment: string) =>
  apiFetch<Message>(`${messageUrl(m)}/forward`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: channelId, ...(comment ? { comment } : {}) }),
  });

// --- burn-on-read ----------------------------------------------------------------

/** The times a burn-on-read message can be read for, in seconds. */
export const BURN_TIMES = [10, 30, 60, 300, 3600] as const;

export const revealMessage = (m: Pick<Message, 'id' | 'channel_id'>) =>
  apiFetch<Message>(`${messageUrl(m)}/reveal`, { method: 'POST' });

/** Shows a revealed burn-on-read message wherever it is loaded. */
export function applyRevealed(queryClient: QueryClient, message: Message) {
  patchMessage(queryClient, message.channel_id, message.id, (m) => ({
    ...message,
    reactions: m.reactions,
  }));
  addMessage(queryClient, message);
}

/** The text is gone: its time ran out. */
export function applyBurned(queryClient: QueryClient, m: Pick<Message, 'id' | 'channel_id'>) {
  patchMessage(queryClient, m.channel_id, m.id, (x) => ({
    ...x,
    body: '',
    link_preview: undefined,
    burn: x.burn ? { ...x.burn, hidden: true } : x.burn,
  }));
}

// --- custom emoji and stickers ------------------------------------------------------

export const customEmojiQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['custom-emoji', workspaceId],
    queryFn: () =>
      apiFetch<{ emoji: CustomEmoji[] }>(`/api/workspaces/${workspaceId}/emoji`).then(
        (r) => r.emoji,
      ),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
  });

export const stickersQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ['stickers', workspaceId],
    queryFn: () =>
      apiFetch<{ stickers: Sticker[] }>(`/api/workspaces/${workspaceId}/stickers`).then(
        (r) => r.stickers,
      ),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
  });

const picture = (file: File): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: file,
});

export const addCustomEmoji = (workspaceId: string, name: string, file: File) =>
  apiFetch<CustomEmoji>(
    `/api/workspaces/${workspaceId}/emoji?name=${encodeURIComponent(name)}`,
    picture(file),
  );

export const deleteCustomEmoji = (id: string) =>
  apiFetch<void>(`/api/emoji/${id}`, { method: 'DELETE' });

export const addSticker = (workspaceId: string, name: string, file: File) =>
  apiFetch<Sticker>(
    `/api/workspaces/${workspaceId}/stickers?name=${encodeURIComponent(name)}`,
    picture(file),
  );

export const deleteSticker = (id: string) =>
  apiFetch<void>(`/api/stickers/${id}`, { method: 'DELETE' });

/** A custom emoji reaction or text code: ":name:". */
export const CUSTOM_EMOJI = /^:([a-z0-9_+-]{2,32}):$/;

/** Turns a name typed by an admin into a usable emoji name. */
export const emojiName = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_+-]/g, '')
    .slice(0, 32);
