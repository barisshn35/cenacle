// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  BotIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  WebhookIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { BotBadge } from './bot-badge';
import {
  botsQuery,
  botTokensQuery,
  createBot,
  createBotToken,
  createWebhook,
  deleteWebhook,
  revokeBotToken,
  updateBot,
  webhooksQuery,
  type Bot,
  type BotScope,
  type Webhook,
} from './bots';
import { directoryQuery, isConversation } from './data';
import type { Workspace } from './workspaces';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function problemOf(err: unknown) {
  return err instanceof ApiError ? err.problem : { status: 500 };
}

/** A secret shown once, with a copy button. */
function Secret({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
    >
      <p className="font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code
          data-testid="secret"
          className="min-w-0 flex-1 font-mono text-xs break-all select-all"
        >
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => toast(t('bots.copied')))
              .catch(() => toast.error(t('bots.copyFailed')))
          }
        >
          <CopyIcon aria-hidden strokeWidth={1.75} />
          {t('bots.copy')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('bots.shownOnce')}</p>
    </div>
  );
}

function CreateBotForm({ workspace, onDone }: { workspace: Workspace; onDone: (b: Bot) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => createBot(workspace.id, name.trim(), description.trim()),
    onSuccess: async (bot) => {
      await queryClient.invalidateQueries({ queryKey: ['bots', workspace.id] });
      onDone(bot);
    },
  });
  return (
    <form
      className="grid gap-2 rounded-lg border p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (name.trim()) create.mutate();
      }}
    >
      <Label htmlFor={`${id}-name`}>{t('bots.name')}</Label>
      <Input
        id={`${id}-name`}
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <Label htmlFor={`${id}-description`}>{t('bots.description')}</Label>
      <Input
        id={`${id}-description`}
        value={description}
        maxLength={250}
        onChange={(e) => setDescription(e.target.value)}
      />
      {create.isError && <InlineError problem={problemOf(create.error)} />}
      <Button
        type="submit"
        className="justify-self-start"
        disabled={!name.trim() || create.isPending}
      >
        {t('bots.create')}
      </Button>
    </form>
  );
}

function Tokens({ bot }: { bot: Bot }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const tokens = useQuery(botTokensQuery(bot.id));
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<BotScope[]>(['messages:write']);
  const [days, setDays] = useState('365');
  const [secret, setSecret] = useState<string>();
  const [revoking, setRevoking] = useState<{ id: string; name: string }>();
  const reload = () => queryClient.invalidateQueries({ queryKey: ['bot-tokens', bot.id] });
  const create = useMutation({
    mutationFn: () =>
      createBotToken(bot.id, {
        name: name.trim(),
        scopes,
        ...(days ? { expires_in_days: Number(days) } : {}),
      }),
    onSuccess: async ({ secret }) => {
      setSecret(secret);
      setName('');
      await reload();
    },
  });
  const toggle = (scope: BotScope, on: boolean) =>
    setScopes((s) => (on ? [...s, scope] : s.filter((x) => x !== scope)));

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
        <KeyRoundIcon aria-hidden strokeWidth={1.75} className="size-4" />
        {t('bots.tokens')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('bots.tokensHint')}</p>
      {tokens.isPending ? (
        <Skeleton className="h-9" />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {(tokens.data ?? []).length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('bots.noTokens')}</li>
          )}
          {(tokens.data ?? []).map((tk) => (
            <li
              key={tk.id}
              data-testid="token"
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{tk.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {tk.scopes.join(', ')}
                  {tk.expires_at &&
                    ` · ${t('bots.expires', { date: new Date(tk.expires_at).toLocaleDateString() })}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                aria-label={t('bots.revokeNamed', { token: tk.name })}
                onClick={() => setRevoking({ id: tk.id, name: tk.name })}
              >
                {t('glossary.revokeToken')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {secret && <Secret label={t('bots.tokenCreated')} value={secret} />}
      <form
        className="grid gap-2 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && scopes.length) create.mutate();
        }}
      >
        <Label htmlFor={`${id}-name`}>{t('bots.tokenName')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="flex flex-wrap gap-x-4">
          <legend className="mb-1 text-sm font-medium">{t('bots.scopes')}</legend>
          {(['messages:write', 'messages:read'] as const).map((scope) => (
            <label key={scope} data-target className="flex min-h-target items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) => toggle(scope, e.target.checked)}
                className="size-4 accent-primary"
                // The whole label is the target (at least 24 px).
                data-target-exempt
              />
              {t(`bots.scope.${scope === 'messages:write' ? 'write' : 'read'}`)}
            </label>
          ))}
        </fieldset>
        <Label htmlFor={`${id}-days`}>{t('bots.expiry')}</Label>
        <select
          id={`${id}-days`}
          className={selectClass}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        >
          <option value="30">{t('bots.days', { count: 30 })}</option>
          <option value="90">{t('bots.days', { count: 90 })}</option>
          <option value="365">{t('bots.days', { count: 365 })}</option>
          <option value="">{t('bots.never')}</option>
        </select>
        {create.isError && <InlineError problem={problemOf(create.error)} />}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={!name.trim() || scopes.length === 0 || create.isPending}
        >
          <PlusIcon aria-hidden strokeWidth={1.75} />
          {t('bots.createToken')}
        </Button>
      </form>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        severity="s3"
        irreversible
        title={t('bots.revokeTitle', { token: revoking?.name ?? '' })}
        description={<p>{t('bots.revokeDescription', { bot: bot.name })}</p>}
        confirmLabel={t('glossary.revokeToken')}
        onConfirm={async () => {
          await revokeBotToken(bot.id, revoking!.id);
          await reload();
          toast(t('bots.revoked', { token: revoking!.name }));
        }}
      />
    </section>
  );
}

function Webhooks({ bot, workspace }: { bot: Bot; workspace: Workspace }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const hooks = useQuery(webhooksQuery(bot.id));
  const channels = useQuery(directoryQuery(workspace.id));
  const options = (channels.data ?? []).filter((c) => !isConversation(c) && !c.archived);
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [kind, setKind] = useState<Webhook['kind']>('generic');
  const [url, setUrl] = useState<string>();
  const [removing, setRemoving] = useState<Webhook>();
  const reload = () => queryClient.invalidateQueries({ queryKey: ['webhooks', bot.id] });
  const channel = channelId || options[0]?.id || '';
  const create = useMutation({
    mutationFn: () => createWebhook(bot.id, { name: name.trim(), channel_id: channel, kind }),
    onSuccess: async ({ url }) => {
      setUrl(url);
      setName('');
      await reload();
    },
  });

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
        <WebhookIcon aria-hidden strokeWidth={1.75} className="size-4" />
        {t('bots.webhooks')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('bots.webhooksHint')}</p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {(hooks.data ?? []).length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">{t('bots.noWebhooks')}</li>
        )}
        {(hooks.data ?? []).map((h) => (
          <li
            key={h.id}
            data-testid="webhook"
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{h.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {t(`bots.kind.${h.kind}`)} → {h.channel_name}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              aria-label={t('bots.deleteWebhookNamed', { webhook: h.name })}
              onClick={() => setRemoving(h)}
            >
              {t('glossary.delete')}
            </Button>
          </li>
        ))}
      </ul>
      {url && (
        <Secret
          label={kind === 'jira' ? t('bots.webhookCreatedJira') : t('bots.webhookCreated')}
          value={url}
        />
      )}
      <form
        className="grid gap-2 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && channel) create.mutate();
        }}
      >
        <Label htmlFor={`${id}-name`}>{t('bots.webhookName')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Label htmlFor={`${id}-channel`}>{t('bots.channel')}</Label>
        <select
          id={`${id}-channel`}
          className={selectClass}
          value={channel}
          onChange={(e) => setChannelId(e.target.value)}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Label htmlFor={`${id}-kind`}>{t('bots.kindLabel')}</Label>
        <select
          id={`${id}-kind`}
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as Webhook['kind'])}
        >
          <option value="generic">{t('bots.kind.generic')}</option>
          <option value="jira">{t('bots.kind.jira')}</option>
        </select>
        {create.isError && <InlineError problem={problemOf(create.error)} />}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={!name.trim() || !channel || create.isPending}
        >
          <PlusIcon aria-hidden strokeWidth={1.75} />
          {t('bots.createWebhook')}
        </Button>
      </form>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        severity="s3"
        irreversible
        title={t('bots.deleteWebhookTitle', { webhook: removing?.name ?? '' })}
        description={<p>{t('bots.deleteWebhookDescription')}</p>}
        confirmLabel={t('bots.deleteWebhook')}
        onConfirm={async () => {
          await deleteWebhook(bot.id, removing!.id);
          await reload();
        }}
      />
    </section>
  );
}

function BotDetails({
  bot,
  workspace,
  onBack,
}: {
  bot: Bot;
  workspace: Workspace;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const setDisabled = async (disabled: boolean) => {
    await updateBot(bot.id, { disabled });
    await queryClient.invalidateQueries({ queryKey: ['bots', workspace.id] });
  };
  const enable = useMutation({
    mutationFn: () => setDisabled(false),
    onError: () => toast.error(t('bots.changeFailed')),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label={t('bots.back')} onClick={onBack}>
          <ArrowLeftIcon strokeWidth={1.75} />
        </Button>
        <h3 className="flex-1 truncate font-semibold">{bot.name}</h3>
        {bot.disabled ? (
          <Button
            size="sm"
            variant="outline"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            {t('glossary.enable')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirmDisable(true)}>
            {t('glossary.disable')}
          </Button>
        )}
      </div>
      {bot.disabled && <p className="text-sm text-muted-foreground">{t('bots.disabledNotice')}</p>}
      <p className="text-sm text-muted-foreground">{t('bots.addToChannels')}</p>
      <Tokens bot={bot} />
      <Webhooks bot={bot} workspace={workspace} />
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        severity="s2"
        title={t('bots.disableTitle', { bot: bot.name })}
        description={<p>{t('bots.disableDescription')}</p>}
        confirmLabel={t('bots.disable')}
        onConfirm={async () => {
          await setDisabled(true);
          toast(t('bots.disabled', { bot: bot.name }));
        }}
      />
    </div>
  );
}

/** Bots of a workspace with their tokens and webhooks (owners and admins). */
export function IntegrationsDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const bots = useQuery(botsQuery(workspace.id));
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const bot = bots.data?.find((b) => b.id === selected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('bots.title')}</DialogTitle>
          <DialogDescription>
            {t('bots.titleDescription', { workspace: workspace.name })}
          </DialogDescription>
        </DialogHeader>
        {bot ? (
          <BotDetails bot={bot} workspace={workspace} onBack={() => setSelected(undefined)} />
        ) : (
          <div className="flex flex-col gap-3">
            {bots.isPending ? (
              <Skeleton className="h-10" />
            ) : (
              <ul className="flex flex-col divide-y rounded-lg border">
                {(bots.data ?? []).length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted-foreground">{t('bots.none')}</li>
                )}
                {(bots.data ?? []).map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(b.id)}
                      className="flex min-h-target w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <BotIcon
                        aria-hidden
                        strokeWidth={1.75}
                        className="size-4 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{b.name}</span>
                        {b.description && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {b.description}
                          </span>
                        )}
                      </span>
                      <BotBadge />
                      {b.disabled && (
                        <span className="text-xs text-muted-foreground">
                          {t('bots.disabledLabel')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {creating ? (
              <CreateBotForm
                workspace={workspace}
                onDone={(b) => {
                  setCreating(false);
                  setSelected(b.id);
                }}
              />
            ) : (
              <Button variant="outline" className="self-start" onClick={() => setCreating(true)}>
                <PlusIcon aria-hidden strokeWidth={1.75} />
                {t('bots.new')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
