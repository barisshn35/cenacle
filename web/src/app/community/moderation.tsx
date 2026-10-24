// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BotIcon, FlagIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { removeMessage, type Message } from '../chat/data';
import type { Workspace } from '../chat/workspaces';
import { plainText } from '../search/search';
import {
  automodQuery,
  createAutomodRule,
  deleteAutomodRule,
  reportMessage,
  reportsQuery,
  resolveReport,
  setMemberTimeout,
  updateAutomodRule,
  type AutomodRule,
  type AutomodRuleInput,
  type Report,
} from './community';
import { dateLocale } from '../../i18n/time-format';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Durations moderators time members out for, in minutes. */
const TIMEOUTS = [10, 60, 1440, 10080] as const;

/** Asking the workspace's moderators to look at a message. */
export function ReportDialog({
  message,
  open,
  onOpenChange,
}: {
  message: Message;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () => reportMessage(message.channel_id, message.id, reason.trim()),
    onSuccess: () => {
      toast.success(t('community.report.sent'));
      setReason('');
      onOpenChange(false);
    },
    onError: () => toast.error(t('community.report.failed')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('community.report.title')}</DialogTitle>
          <DialogDescription>{t('community.report.hint')}</DialogDescription>
        </DialogHeader>
        <blockquote className="line-clamp-3 border-s-2 ps-3 text-sm text-muted-foreground">
          {plainText(message.body)}
        </blockquote>
        <div className="grid gap-1">
          <Label htmlFor={id}>{t('community.report.reason')}</Label>
          <textarea
            id={id}
            value={reason}
            maxLength={1000}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
        <DialogFooter>
          <Button disabled={send.isPending} onClick={() => send.mutate()}>
            <FlagIcon strokeWidth={1.75} />
            {t('community.report.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A member menu entry: time a member out, or end it. */
export function TimeoutSelect({
  workspace,
  userId,
  name,
}: {
  workspace: Workspace;
  userId: string;
  name: string;
}) {
  const { t } = useTranslation();
  const set = useMutation({
    mutationFn: (minutes: number) =>
      setMemberTimeout(
        workspace.id,
        userId,
        minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
      ),
    onSuccess: (_, minutes) =>
      toast.success(
        minutes
          ? t('community.moderation.timedOut', { name })
          : t('community.moderation.timeoutEnded', { name }),
      ),
    onError: () => toast.error(t('community.moderation.failed')),
  });
  return (
    <>
      <label htmlFor={`timeout-${userId}`} className="sr-only">
        {t('community.moderation.timeoutOf', { name })}
      </label>
      <select
        id={`timeout-${userId}`}
        className={cn(selectClass, 'w-auto')}
        value=""
        disabled={set.isPending}
        onChange={(e) => e.target.value !== '' && set.mutate(Number(e.target.value))}
      >
        <option value="">{t('community.moderation.timeout')}</option>
        {TIMEOUTS.map((m) => (
          <option key={m} value={m}>
            {t(`community.moderation.durations.${m}`)}
          </option>
        ))}
        <option value={0}>{t('community.moderation.endTimeout')}</option>
      </select>
    </>
  );
}

/** Workspace moderation: the report queue and AutoMod rules. */
export function ModerationDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'queue' | 'closed' | 'automod'>('queue');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
        data-testid="moderation"
      >
        <DialogHeader>
          <DialogTitle>
            {t('community.moderation.title', { workspace: workspace.name })}
          </DialogTitle>
          <DialogDescription>{t('community.moderation.description')}</DialogDescription>
        </DialogHeader>
        <div
          role="tablist"
          aria-label={t('community.moderation.title', { workspace: workspace.name })}
          className="flex gap-1"
        >
          {(['queue', 'closed', 'automod'] as const).map((k) => (
            <Button
              key={k}
              role="tab"
              size="sm"
              variant={tab === k ? 'secondary' : 'ghost'}
              aria-selected={tab === k}
              onClick={() => setTab(k)}
            >
              {t(`community.moderation.tabs.${k}`)}
            </Button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === 'automod' ? (
            <AutomodRules workspace={workspace} />
          ) : (
            <Queue workspace={workspace} status={tab === 'queue' ? 'open' : 'closed'} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Queue({ workspace, status }: { workspace: Workspace; status: 'open' | 'closed' }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const reports = useQuery(reportsQuery(workspace.id, status));
  const [timeouts, setTimeouts] = useState<Record<string, number>>({});
  const date = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const resolve = useMutation({
    mutationFn: ({
      report,
      action,
    }: {
      report: Report;
      action: 'dismiss' | 'delete' | 'timeout';
    }) =>
      resolveReport(
        report.id,
        action,
        action === 'timeout' ? (timeouts[report.id] ?? 60) : undefined,
      ),
    onSuccess: (_, { report, action }) => {
      if (action === 'delete') removeMessage(queryClient, report.message);
      void queryClient.invalidateQueries({ queryKey: ['reports', workspace.id] });
      toast.success(t(`community.moderation.resolved.${action}`));
    },
    onError: (err) =>
      toast.error(
        (err instanceof ApiError && err.problem.detail) || t('community.moderation.failed'),
      ),
  });
  if (reports.isPending) return <Skeleton className="h-20" />;
  const list = reports.data ?? [];
  if (list.length === 0) {
    return (
      <p role="status" className="py-6 text-center text-sm text-muted-foreground">
        {status === 'open'
          ? t('community.moderation.empty')
          : t('community.moderation.emptyClosed')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="reports">
      {list.map((r) => (
        <li
          key={r.id}
          data-testid="report"
          className="flex flex-col gap-2 rounded-[10px] border border-rule-strong p-3 text-sm"
        >
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {r.reporter ? (
              <span>{t('community.moderation.reportedBy', { name: r.reporter.display_name })}</span>
            ) : (
              <span className="flex items-center gap-1">
                <BotIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                {t('community.moderation.flaggedBy', { rule: r.rule_name })}
              </span>
            )}
            <span>· #{r.channel.name}</span>
            <time dateTime={r.created_at}>· {date.format(new Date(r.created_at))}</time>
            {r.reports > 1 && <span>· {t('community.moderation.more', { count: r.reports })}</span>}
          </p>
          <p>
            <span className="font-medium">{r.message.author.display_name}: </span>
            <span className="break-words">{plainText(r.message.body, 400)}</span>
          </p>
          {r.reason && <p className="text-muted-foreground">“{r.reason}”</p>}
          {status === 'open' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ report: r, action: 'dismiss' })}
              >
                {t('community.moderation.dismiss')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ report: r, action: 'delete' })}
              >
                <Trash2Icon strokeWidth={1.75} />
                {t('community.moderation.deleteMessage')}
              </Button>
              <label htmlFor={`to-${r.id}`} className="sr-only">
                {t('community.moderation.timeoutFor')}
              </label>
              <select
                id={`to-${r.id}`}
                className={cn(selectClass, 'w-auto')}
                value={timeouts[r.id] ?? 60}
                onChange={(e) => setTimeouts({ ...timeouts, [r.id]: Number(e.target.value) })}
              >
                {TIMEOUTS.map((m) => (
                  <option key={m} value={m}>
                    {t(`community.moderation.durations.${m}`)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ report: r, action: 'timeout' })}
              >
                {t('community.moderation.timeoutAuthor')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(`community.moderation.outcome.${r.action || 'none'}`)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

const EMPTY_RULE: AutomodRuleInput = {
  name: '',
  kind: 'keywords',
  action: 'block',
  words: [],
  max_mentions: 5,
  allowed_domains: [],
  exempt_roles: ['owner', 'admin'],
  enabled: true,
};

function AutomodRules({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const rules = useQuery(automodQuery(workspace.id));
  const [editing, setEditing] = useState<AutomodRule | 'new' | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['automod', workspace.id] });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAutomodRule(id),
    onSuccess: refresh,
    onError: () => toast.error(t('community.moderation.failed')),
  });
  if (editing) {
    return (
      <RuleForm
        workspace={workspace}
        rule={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          void refresh();
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t('community.automod.hint')}</p>
      {(rules.data ?? []).map((r) => (
        <div
          key={r.id}
          data-testid="automod-rule"
          className="flex items-center gap-2 rounded-lg border p-2 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {r.name}{' '}
              {!r.enabled && (
                <span className="text-xs text-muted-foreground">
                  ({t('community.automod.off')})
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`community.automod.kinds.${r.kind}`)} ·{' '}
              {t(`community.automod.actions.${r.action}`)}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('community.automod.edit', { name: r.name })}
            onClick={() => setEditing(r)}
          >
            <PencilIcon strokeWidth={1.75} />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('community.automod.remove', { name: r.name })}
            onClick={() => remove.mutate(r.id)}
          >
            <Trash2Icon strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" className="self-start" onClick={() => setEditing('new')}>
        {t('community.automod.add')}
      </Button>
    </div>
  );
}

function RuleForm({
  workspace,
  rule,
  onDone,
}: {
  workspace: Workspace;
  rule: AutomodRule | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const ids = { name: useId(), kind: useId(), action: useId(), list: useId(), max: useId() };
  const [form, setForm] = useState<AutomodRuleInput>(rule ?? EMPTY_RULE);
  const [list, setList] = useState(
    ((rule?.kind === 'links' ? rule.allowed_domains : rule?.words) ?? []).join('\n'),
  );
  const save = useMutation({
    mutationFn: () => {
      const items = list
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body: AutomodRuleInput = {
        ...form,
        words: form.kind === 'keywords' ? items : [],
        allowed_domains: form.kind === 'links' ? items : [],
      };
      return rule ? updateAutomodRule(rule.id, body) : createAutomodRule(workspace.id, body);
    },
    onSuccess: onDone,
    onError: (err) =>
      toast.error(
        (err instanceof ApiError && err.problem.detail) || t('community.moderation.failed'),
      ),
  });
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="automod-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor={ids.name}>{t('community.automod.name')}</Label>
        <Input
          id={ids.name}
          value={form.name}
          maxLength={80}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <Label htmlFor={ids.kind}>{t('community.automod.kind')}</Label>
          <select
            id={ids.kind}
            className={selectClass}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as AutomodRuleInput['kind'] })}
          >
            {(['keywords', 'mentions', 'links'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`community.automod.kinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={ids.action}>{t('community.automod.action')}</Label>
          <select
            id={ids.action}
            className={selectClass}
            value={form.action}
            onChange={(e) =>
              setForm({ ...form, action: e.target.value as AutomodRuleInput['action'] })
            }
          >
            {(['block', 'flag'] as const).map((a) => (
              <option key={a} value={a}>
                {t(`community.automod.actions.${a}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {form.kind === 'mentions' ? (
        <div className="grid gap-1">
          <Label htmlFor={ids.max}>{t('community.automod.maxMentions')}</Label>
          <Input
            id={ids.max}
            type="number"
            min={1}
            max={100}
            value={form.max_mentions ?? 5}
            onChange={(e) => setForm({ ...form, max_mentions: Number(e.target.value) })}
          />
        </div>
      ) : (
        <div className="grid gap-1">
          <Label htmlFor={ids.list}>
            {form.kind === 'keywords'
              ? t('community.automod.words')
              : t('community.automod.domains')}
          </Label>
          <textarea
            id={ids.list}
            rows={4}
            value={list}
            onChange={(e) => setList(e.target.value)}
            aria-describedby={`${ids.list}-hint`}
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p id={`${ids.list}-hint`} className="text-xs text-muted-foreground">
            {form.kind === 'keywords'
              ? t('community.automod.wordsHint')
              : t('community.automod.domainsHint')}
          </p>
        </div>
      )}
      <label data-target className="flex min-h-target items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-target-exempt
          className="size-4 accent-primary"
          checked={form.exempt_roles?.includes('member') ?? false}
          onChange={(e) =>
            setForm({
              ...form,
              exempt_roles: e.target.checked ? ['owner', 'admin', 'member'] : ['owner', 'admin'],
            })
          }
        />
        {t('community.automod.exemptMembers')}
      </label>
      <label data-target className="flex min-h-target items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-target-exempt
          className="size-4 accent-primary"
          checked={form.enabled ?? true}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        {t('community.automod.enabled')}
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {t('community.automod.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('glossary.cancel')}
        </Button>
      </div>
    </form>
  );
}
