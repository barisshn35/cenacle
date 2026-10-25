// SPDX-License-Identifier: AGPL-3.0-only
import { sealFor } from '../compliance/e2e';
import { isMLS } from '../e2e/channels';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type CommandInfo = components['schemas']['CommandInfo'];
export type CommandResult = components['schemas']['CommandResult'];
export type ScheduledMessage = components['schemas']['ScheduledMessage'];

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The built-in and bot commands of a workspace. */
export const commandsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['commands', workspaceId],
    queryFn: () =>
      apiFetch<{ commands: CommandInfo[] }>(`/api/workspaces/${workspaceId}/commands`).then(
        (r) => r.commands,
      ),
    staleTime: 5 * 60_000,
  });

/**
 * Splits "/name rest" into the command and its text; "//text" and anything
 * not starting with "/" is a message.
 */
export function parseCommand(input: string): { command: string; text: string } | null {
  const m = /^\/([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return m ? { command: m[1]!.toLowerCase(), text: (m[2] ?? '').trim() } : null;
}

export const runCommand = (channelId: string, command: string, text: string) =>
  apiFetch<CommandResult>(
    `/api/channels/${channelId}/commands`,
    json({ command, text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  );

export const scheduledQuery = queryOptions({
  queryKey: ['scheduled'],
  queryFn: () =>
    apiFetch<{ scheduled: ScheduledMessage[] }>('/api/scheduled').then((r) => r.scheduled),
});
export const scheduleMessage = async (channelId: string, body: string, sendAt: Date) => {
  // The server would hold the text until it is sent: not for device-key channels.
  if (isMLS(channelId)) throw new Error('scheduled messages are not for encrypted channels');
  return apiFetch<ScheduledMessage>(
    `/api/channels/${channelId}/scheduled`,
    json({ body: await sealFor(channelId, body), send_at: sendAt.toISOString() }),
  );
};
export const cancelScheduled = (id: string) =>
  apiFetch<void>(`/api/scheduled/${id}`, { method: 'DELETE' });
