// SPDX-License-Identifier: Apache-2.0
import { queryOptions } from '@tanstack/react-query';
import { apiFetch, type components } from '@cenacle/core/api';

export type Bot = components['schemas']['Bot'];
export type BotToken = components['schemas']['BotToken'];
export type Webhook = components['schemas']['Webhook'];
export type BotScope = 'messages:read' | 'messages:write';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const botsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['bots', workspaceId],
    queryFn: () =>
      apiFetch<{ bots: Bot[] }>(`/api/workspaces/${workspaceId}/bots`).then((r) => r.bots),
  });
export const createBot = (workspaceId: string, name: string, description: string) =>
  apiFetch<Bot>(`/api/workspaces/${workspaceId}/bots`, json({ name, description }));
export const updateBot = (
  id: string,
  patch: { name?: string; description?: string; disabled?: boolean },
) => apiFetch<Bot>(`/api/bots/${id}`, json(patch, 'PATCH'));

export const botTokensQuery = (botId: string) =>
  queryOptions({
    queryKey: ['bot-tokens', botId],
    queryFn: () =>
      apiFetch<{ tokens: BotToken[] }>(`/api/bots/${botId}/tokens`).then((r) => r.tokens),
  });
export const createBotToken = (
  botId: string,
  input: { name: string; scopes: BotScope[]; expires_in_days?: number },
) => apiFetch<{ token: BotToken; secret: string }>(`/api/bots/${botId}/tokens`, json(input));
export const revokeBotToken = (botId: string, tokenId: string) =>
  apiFetch<void>(`/api/bots/${botId}/tokens/${tokenId}`, { method: 'DELETE' });

export const webhooksQuery = (botId: string) =>
  queryOptions({
    queryKey: ['webhooks', botId],
    queryFn: () =>
      apiFetch<{ webhooks: Webhook[] }>(`/api/bots/${botId}/webhooks`).then((r) => r.webhooks),
  });
export const createWebhook = (
  botId: string,
  input: { name: string; channel_id: string; kind: Webhook['kind'] },
) => apiFetch<{ webhook: Webhook; url: string }>(`/api/bots/${botId}/webhooks`, json(input));
export const deleteWebhook = (botId: string, webhookId: string) =>
  apiFetch<void>(`/api/bots/${botId}/webhooks/${webhookId}`, { method: 'DELETE' });
