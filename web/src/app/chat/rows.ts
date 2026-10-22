// SPDX-License-Identifier: Apache-2.0
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from './data';
import type { PendingMessage } from './pending';

/** A row of the timeline: a confirmed or a pending message. */
export type Row =
  | {
      kind: 'message';
      key: string;
      message: Message;
      first: boolean;
      day?: string;
      /** The first message that was unread when the channel opened. */
      firstUnread?: boolean;
    }
  | { kind: 'pending'; key: string; pending: PendingMessage };

/** Consecutive messages of one author within 5 minutes share a header. */
const GROUP_MS = 5 * 60_000;

export function useFormatters() {
  const { i18n } = useTranslation();
  return useMemo(
    () => ({
      time: new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }),
      day: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full' }),
      full: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    }),
    [i18n.language],
  );
}

/** Where reading stood when the channel opened, if anything was unread then. */
export interface ReadMark {
  after: string | null;
  self: string;
}

export function toRows(
  messages: Message[],
  pending: PendingMessage[],
  dayFmt: Intl.DateTimeFormat,
  mark: ReadMark | undefined,
): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  let marked = !mark;
  for (const m of messages) {
    const firstUnread =
      !marked && m.author.id !== mark!.self && (mark!.after === null || m.id > mark!.after);
    if (firstUnread) marked = true;
    const at = new Date(m.created_at);
    const day = dayFmt.format(at);
    const newDay = !prev || dayFmt.format(new Date(prev.created_at)) !== day;
    const first =
      newDay ||
      prev!.author.id !== m.author.id ||
      at.getTime() - new Date(prev!.created_at).getTime() > GROUP_MS;
    rows.push({
      kind: 'message',
      key: m.id,
      message: m,
      first: first || firstUnread,
      day: newDay ? day : undefined,
      firstUnread,
    });
    prev = m;
  }
  for (const p of pending) rows.push({ kind: 'pending', key: p.nonce, pending: p });
  return rows;
}
