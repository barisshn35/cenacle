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

/** Issues a new token with the old one's name and scopes; the old one keeps working for the overlap. */
export const rotateBotToken = (botId: string, tokenId: string, overlapHours: number) =>
  apiFetch<{ token: BotToken; secret: string }>(
    `/api/bots/${botId}/tokens/${tokenId}/rotate`,
    json({ overlap_hours: overlapHours }),
  );

export type SlashCommand = components['schemas']['SlashCommand'];
export type Subscription = components['schemas']['Subscription'];
export type Delivery = components['schemas']['Delivery'];
export const SUBSCRIBABLE_EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
] as const;
export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

export const botCommandsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['bot-commands', botId],
    queryFn: () =>
      apiFetch<{ commands: SlashCommand[] }>(`/api/bots/${botId}/commands`).then((r) => r.commands),
  });
export const createBotCommand = (
  botId: string,
  input: { trigger: string; url: string; description: string; hint: string },
) =>
  apiFetch<{ command: SlashCommand; secret: string }>(`/api/bots/${botId}/commands`, json(input));
export const deleteBotCommand = (botId: string, commandId: string) =>
  apiFetch<void>(`/api/bots/${botId}/commands/${commandId}`, { method: 'DELETE' });

export const subscriptionsQuery = (botId: string) =>
  queryOptions({
    queryKey: ['subscriptions', botId],
    queryFn: () =>
      apiFetch<{ subscriptions: Subscription[] }>(`/api/bots/${botId}/subscriptions`).then(
        (r) => r.subscriptions,
      ),
  });
export const createSubscription = (
  botId: string,
  input: { url: string; events: SubscribableEvent[] },
) =>
  apiFetch<{ subscription: Subscription; secret: string }>(
    `/api/bots/${botId}/subscriptions`,
    json(input),
  );
export const deleteSubscription = (botId: string, subscriptionId: string) =>
  apiFetch<void>(`/api/bots/${botId}/subscriptions/${subscriptionId}`, { method: 'DELETE' });
export const deliveriesQuery = (botId: string, subscriptionId: string) =>
  queryOptions({
    queryKey: ['deliveries', botId, subscriptionId],
    queryFn: () =>
      apiFetch<{ deliveries: Delivery[]; has_more: boolean }>(
        `/api/bots/${botId}/subscriptions/${subscriptionId}/deliveries`,
      ),
  });
export const resendDelivery = (botId: string, deliveryId: string) =>
  apiFetch<void>(`/api/bots/${botId}/deliveries/${deliveryId}/resend`, { method: 'POST' });
