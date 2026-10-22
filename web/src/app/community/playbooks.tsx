// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { PlayIcon, PlusIcon, Trash2Icon } from 'lucide-react';
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
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery } from '../chat/data';
import {
  applyRun,
  archivePlaybook,
  channelRunsQuery,
  createPlaybook,
  finishRun,
  playbooksQuery,
  startRun,
  updatePlaybook,
  updateRunItem,
  type Playbook,
  type PlaybookInput,
  type Run,
} from './community';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const areaClass =
  'rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** The workspace's playbooks: start a run; owners and admins write them. */
export function PlaybooksList() {
  const { t } = useTranslation();
  const ws = useActiveWorkspace();
  const queryClient = useQueryClient();
  const playbooks = useQuery(playbooksQuery(ws.id));
  const [editing, setEditing] = useState<Playbook | 'new' | null>(null);
  const [starting, setStarting] = useState<Playbook | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['playbooks', ws.id] });
  const archive = useMutation({
    mutationFn: (p: Playbook) => archivePlaybook(p.id),
    onSuccess: refresh,
    onError: () => toast.error(t('community.playbooks.failed')),
  });
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('community.playbooks.hint')}</p>
      {ws.admin && (
        <Button className="self-start" onClick={() => setEditing('new')}>
          <PlusIcon strokeWidth={1.75} />
          {t('community.playbooks.new')}
        </Button>
      )}
      {playbooks.isPending ? (
        <Skeleton className="h-20" />
      ) : (playbooks.data ?? []).length === 0 ? (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {t('community.playbooks.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {playbooks.data!.map((p) => (
            <li
              key={p.id}
              data-testid="playbook"
              className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm"
            >
              <h2 className="text-base font-semibold">{p.name}</h2>
              {p.description && (
                <p className="whitespace-pre-line text-muted-foreground">{p.description}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('community.playbooks.summary', {
                  lists: p.checklists.length,
                  items: p.checklists.reduce((n, c) => n + c.items.length, 0),
                  runs: p.runs_active,
                })}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" onClick={() => setStarting(p)}>
                  <PlayIcon strokeWidth={1.75} />
                  {t('community.playbooks.start')}
                </Button>
                {ws.admin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                      {t('community.playbooks.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={archive.isPending}
                      onClick={() => archive.mutate(p)}
                    >
                      {t('community.playbooks.archive')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && ws.id && (
        <PlaybookEditor
          workspaceId={ws.id}
          playbook={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {starting && ws.id && (
        <StartRunDialog workspaceId={ws.id} playbook={starting} onClose={() => setStarting(null)} />
      )}
    </>
  );
}

type Draft = { title: string; items: string };

function PlaybookEditor({
  workspaceId,
  playbook,
  onClose,
}: {
  workspaceId: string;
  playbook: Playbook | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ids = { name: useId(), description: useId() };
  const [name, setName] = useState(playbook?.name ?? '');
  const [description, setDescription] = useState(playbook?.description ?? '');
  const [lists, setLists] = useState<Draft[]>(
    playbook?.checklists.map((c) => ({
      title: c.title,
      items: c.items.map((i) => i.title).join('\n'),
    })) ?? [{ title: '', items: '' }],
  );
  const save = useMutation({
    mutationFn: () => {
      const body: PlaybookInput = {
        name: name.trim(),
        description: description.trim(),
        checklists: lists.map((l) => ({
          title: l.title.trim(),
          items: l.items
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title })),
        })),
      };
      return playbook ? updatePlaybook(playbook.id, body) : createPlaybook(workspaceId, body);
    },
    onSuccess: onClose,
    onError: (err) =>
      toast.error(
        (err instanceof ApiError && err.problem.detail) || t('community.playbooks.failed'),
      ),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {playbook ? t('community.playbooks.edit') : t('community.playbooks.new')}
          </DialogTitle>
          <DialogDescription>{t('community.playbooks.editorHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.name}>{t('community.playbooks.name')}</Label>
            <Input
              id={ids.name}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.description}>{t('community.playbooks.description')}</Label>
            <textarea
              id={ids.description}
              rows={2}
              value={description}
              maxLength={4000}
              onChange={(e) => setDescription(e.target.value)}
              className={areaClass}
            />
          </div>
          {lists.map((l, i) => (
            <fieldset key={i} className="flex flex-col gap-1.5 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">
                {t('community.playbooks.checklist', { n: i + 1 })}
              </legend>
              <Input
                aria-label={t('community.playbooks.checklistTitle', { n: i + 1 })}
                placeholder={t('community.playbooks.checklistTitlePlaceholder')}
                value={l.title}
                maxLength={120}
                onChange={(e) =>
                  setLists(lists.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                }
              />
              <textarea
                aria-label={t('community.playbooks.items', { n: i + 1 })}
                placeholder={t('community.playbooks.itemsPlaceholder')}
                rows={4}
                value={l.items}
                onChange={(e) =>
                  setLists(lists.map((x, j) => (j === i ? { ...x, items: e.target.value } : x)))
                }
                className={areaClass}
              />
              {lists.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => setLists(lists.filter((_, j) => j !== i))}
                >
                  <Trash2Icon strokeWidth={1.75} />
                  {t('community.playbooks.removeChecklist')}
                </Button>
              )}
            </fieldset>
          ))}
          {lists.length < 20 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setLists([...lists, { title: '', items: '' }])}
            >
              <PlusIcon strokeWidth={1.75} />
              {t('community.playbooks.addChecklist')}
            </Button>
          )}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {t('community.playbooks.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StartRunDialog({
  workspaceId,
  playbook,
  onClose,
}: {
  workspaceId: string;
  playbook: Playbook;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ids = { name: useId(), channel: useId() };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const channels = (useQuery(channelsQuery).data ?? []).filter(
    (c) =>
      c.workspace_id === workspaceId && c.can_post && c.kind !== 'direct' && c.kind !== 'group',
  );
  const [name, setName] = useState(playbook.name);
  const [channel, setChannel] = useState(channels[0]?.id ?? '');
  const start = useMutation({
    mutationFn: () => startRun(playbook.id, channel, name.trim()),
    onSuccess: (run) => {
      applyRun(queryClient, run);
      void queryClient.invalidateQueries({ queryKey: ['runs', run.channel_id] });
      onClose();
      void navigate({ to: '/c/$channelId', params: { channelId: run.channel_id } });
    },
    onError: (err) =>
      toast.error(
        (err instanceof ApiError && err.problem.detail) || t('community.playbooks.failed'),
      ),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('community.playbooks.startTitle', { name: playbook.name })}</DialogTitle>
          <DialogDescription>{t('community.playbooks.startHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && channel) start.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.name}>{t('community.playbooks.runName')}</Label>
            <Input
              id={ids.name}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.channel}>{t('community.playbooks.channel')}</Label>
            <select
              id={ids.channel}
              className={selectClass}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={start.isPending || !name.trim() || !channel}>
              {t('community.playbooks.start')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** In the channel details: the runs of playbooks here, checked off as they go. */
export function RunsSection({ channelId, canPost }: { channelId: string; canPost: boolean }) {
  const { t } = useTranslation();
  const runs = useQuery(channelRunsQuery(channelId));
  const list = runs.data ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="runs-title" className="flex flex-col gap-2" data-testid="runs">
      <h3 id="runs-title" className="text-xs font-medium text-muted-foreground uppercase">
        {t('community.playbooks.runs')}
      </h3>
      {list.map((r) => (
        <RunCard key={r.id} run={r} canPost={canPost} />
      ))}
    </section>
  );
}

function RunCard({ run, canPost }: { run: Run; canPost: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(run.status === 'active');
  const total = run.checklists.reduce((n, c) => n + c.items.length, 0);
  const done = run.checklists.reduce(
    (n, c) => n + c.items.filter((i) => i.done_at || i.skipped).length,
    0,
  );
  const active = run.status === 'active';
  const check = useMutation({
    mutationFn: (c: { checklist: number; item: number; done: boolean }) => updateRunItem(run.id, c),
    onSuccess: (r) => applyRun(queryClient, r),
    onError: () => toast.error(t('community.playbooks.failed')),
  });
  const finish = useMutation({
    mutationFn: () => finishRun(run.id),
    onSuccess: (r) => applyRun(queryClient, r),
    onError: (err) =>
      toast.error(
        (err instanceof ApiError && err.problem.detail) || t('community.playbooks.failed'),
      ),
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2 text-sm" data-testid="run">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-target items-center gap-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{run.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {active
            ? t('community.playbooks.progress', { done, total })
            : t('community.playbooks.finished')}
        </span>
      </button>
      {open && (
        <>
          {run.checklists.map((c, ci) => (
            <fieldset key={ci} className="flex flex-col">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">{c.title}</legend>
              {c.items.map((it, ii) => (
                <label key={ii} data-target className="flex min-h-target items-center gap-2">
                  <input
                    type="checkbox"
                    data-target-exempt
                    className="size-4 accent-primary"
                    checked={!!it.done_at}
                    disabled={!active || !canPost || check.isPending}
                    onChange={(e) =>
                      check.mutate({ checklist: ci, item: ii, done: e.target.checked })
                    }
                  />
                  <span
                    className={cn(
                      it.done_at && 'text-muted-foreground line-through',
                      it.skipped && 'text-muted-foreground italic',
                    )}
                  >
                    {it.title}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          {active && canPost && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={finish.isPending}
              onClick={() => finish.mutate()}
            >
              {t('community.playbooks.finish')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
