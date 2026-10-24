// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, EllipsisIcon, MapPinIcon, PencilIcon, PlusIcon, XIcon } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { cn } from '@cenacle/ui/lib/utils';
import { UserAvatar } from '../profile/avatar';
import { Board, BoardGroup } from '../shell/board';
import { boardCell, boardRow } from '../shell/board-styles';
import { useActiveWorkspace } from '../chat/active-workspace';
import { channelsQuery } from '../chat/data';
import {
  cancelEvent,
  createEvent,
  eventsQuery,
  rsvpEvent,
  updateEvent,
  type CommunityEvent,
  type EventInput,
} from './community';
import { dateLocale } from '../../i18n/time-format';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** A local "yyyy-MM-ddTHH:mm" for datetime-local inputs. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The workspace's coming events: answer, plan, change or cancel them. */
export function EventsList() {
  const { t, i18n } = useTranslation();
  const ws = useActiveWorkspace();
  const queryClient = useQueryClient();
  const events = useQuery(eventsQuery(ws.id));
  const channels = useQuery(channelsQuery).data ?? [];
  const [editing, setEditing] = useState<CommunityEvent | 'new' | null>(null);
  const mobile = useIsMobile();
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    hour: '2-digit',
    minute: '2-digit',
  });
  const day = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const dayLabel = (d: Date) => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString())
      return `${t('community.events.today')} · ${day.format(d)}`;
    if (d.toDateString() === tomorrow.toDateString())
      return `${t('community.events.tomorrow')} · ${day.format(d)}`;
    return day.format(d);
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['events', ws.id] });
  const answer = useMutation({
    mutationFn: ({ e, status }: { e: CommunityEvent; status: CommunityEvent['me'] }) =>
      rsvpEvent(e.id, status),
    onSuccess: refresh,
    onError: () => toast.error(t('community.events.failed')),
  });
  const cancel = useMutation({
    mutationFn: (e: CommunityEvent) => cancelEvent(e.id),
    onSuccess: () => {
      void refresh();
      toast.success(t('community.events.canceled'));
    },
    onError: () => toast.error(t('community.events.failed')),
  });
  const list = events.data ?? [];
  const groups: { label: string; rows: CommunityEvent[] }[] = [];
  for (const e of list) {
    const label = dayLabel(new Date(e.starts_at));
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(e);
    else groups.push({ label, rows: [e] });
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const timeCell = (e: CommunityEvent) => (
    <span className="flex flex-col font-mono">
      <time dateTime={e.starts_at} className="text-[14px] font-medium">
        {time.format(new Date(e.starts_at))}
      </time>
      <time dateTime={e.ends_at} className="text-xs text-muted-foreground">
        –{time.format(new Date(e.ends_at))}
      </time>
    </span>
  );
  const eventCell = (e: CommunityEvent) => (
    <span className="flex min-w-0 flex-col">
      <span className="font-semibold break-words">{e.title}</span>
      {e.description && (
        <span className="line-clamp-2 text-[13px] text-muted-foreground">{e.description}</span>
      )}
    </span>
  );
  const whereCell = (e: CommunityEvent) => {
    const channel = channels.find((c) => c.id === e.channel_id);
    return (
      <span className="flex min-w-0 items-start gap-1.5">
        {e.location && (
          <MapPinIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
        )}
        <span className="min-w-0">
          {e.location && <span className="block break-words">{e.location}</span>}
          {channel && (
            <span className="block text-xs text-muted-foreground">
              {t('community.events.announcedIn', { channel: channel.name })}
            </span>
          )}
        </span>
      </span>
    );
  };
  const whoCell = (e: CommunityEvent) => (
    <span className="flex flex-col gap-1">
      {e.going.length > 0 && (
        <span className="flex gap-0.5">
          {e.going.slice(0, 4).map((g) => (
            <UserAvatar key={g.id} userId={g.id} name={g.display_name} size="xs" />
          ))}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {t('community.events.going', { count: e.going.length })}
        {e.maybe > 0 && ` · ${t('community.events.maybeCount', { count: e.maybe })}`}
      </span>
    </span>
  );
  const answerCell = (e: CommunityEvent) => (
    <span
      role="group"
      aria-label={t('community.events.answerFor', { title: e.title })}
      className="inline-flex overflow-hidden rounded-[7px] border border-rule-strong"
    >
      {(['going', 'maybe', 'declined'] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={e.me === s}
          disabled={answer.isPending}
          onClick={() => answer.mutate({ e, status: e.me === s ? null : s })}
          className={cn(
            'flex h-8 min-h-target items-center gap-1 border-l border-rule-strong px-2.5 text-[13px] font-medium whitespace-nowrap outline-none first:border-l-0 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-60',
            e.me === s
              ? 'bg-accent font-semibold shadow-[inset_0_0_0_1px_var(--color-primary)]'
              : 'bg-background hover:bg-muted',
          )}
        >
          {e.me === s && (
            <CheckIcon aria-hidden className="size-3.5 text-primary" strokeWidth={2} />
          )}
          {t(`community.events.rsvp.${s}`)}
        </button>
      ))}
    </span>
  );
  const menuCell = (e: CommunityEvent) =>
    e.can_edit ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('community.events.actionsFor', { title: e.title })}
            />
          }
        >
          <EllipsisIcon strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditing(e)}>
            <PencilIcon strokeWidth={1.75} />
            {t('community.events.edit')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => cancel.mutate(e)}>
            <XIcon strokeWidth={1.75} />
            {t('community.events.cancel')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 max-sm:px-4">
        <p className="text-xs text-muted-foreground">{t('community.events.zone', { zone })}</p>
        {ws.workspace?.role !== 'guest' && (
          <Button className="ms-auto" onClick={() => setEditing('new')}>
            <PlusIcon strokeWidth={1.75} />
            {t('community.events.new')}
          </Button>
        )}
      </div>
      {events.isPending ? (
        <Skeleton className="h-24" />
      ) : list.length === 0 ? (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {t('community.events.none')}
        </p>
      ) : mobile ? (
        <div className="flex flex-col">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2 className="bg-secondary px-4 py-2 text-[12.5px] font-semibold">{g.label}</h2>
              <ul>
                {g.rows.map((e) => (
                  <li
                    key={e.id}
                    data-testid="event"
                    className="flex flex-col gap-2 border-b px-4 py-3 text-sm"
                  >
                    <div className="flex items-start gap-3">
                      {timeCell(e)}
                      <div className="min-w-0 flex-1">{eventCell(e)}</div>
                      {menuCell(e)}
                    </div>
                    {whereCell(e)}
                    {whoCell(e)}
                    {answerCell(e)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <Board
          label={t('home.events')}
          columns={[
            { label: t('community.events.columns.time'), width: 'w-[96px]' },
            { label: t('community.events.columns.event') },
            { label: t('community.events.columns.where'), width: 'w-[200px]' },
            { label: t('community.events.columns.who'), width: 'w-[160px]' },
            { label: t('community.events.columns.answer'), width: 'w-[248px]' },
            {
              label: <span className="sr-only">{t('community.events.columns.actions')}</span>,
              width: 'w-[52px]',
            },
          ]}
        >
          {groups.map((g) => (
            <BoardGroup key={g.label} span={6} label={g.label}>
              {g.rows.map((e) => (
                <tr key={e.id} data-testid="event" className={cn(boardRow(), 'h-[76px] text-sm')}>
                  <td className={boardCell}>{timeCell(e)}</td>
                  <td className={boardCell}>{eventCell(e)}</td>
                  <td className={boardCell}>{whereCell(e)}</td>
                  <td className={boardCell}>{whoCell(e)}</td>
                  <td className={boardCell}>{answerCell(e)}</td>
                  <td className={cn(boardCell, 'text-right')}>{menuCell(e)}</td>
                </tr>
              ))}
            </BoardGroup>
          ))}
        </Board>
      )}
      {editing && ws.id && (
        <EventDialog
          workspaceId={ws.id}
          event={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function EventDialog({
  workspaceId,
  event,
  onClose,
}: {
  workspaceId: string;
  event: CommunityEvent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ids = {
    title: useId(),
    start: useId(),
    end: useId(),
    location: useId(),
    channel: useId(),
    description: useId(),
  };
  const channels = (useQuery(channelsQuery).data ?? []).filter(
    (c) =>
      c.workspace_id === workspaceId && c.can_post && c.kind !== 'direct' && c.kind !== 'group',
  );
  const [start] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setMinutes(0, 0, 0);
    return d;
  });
  const [form, setForm] = useState({
    title: event?.title ?? '',
    starts: localInput(event ? new Date(event.starts_at) : start),
    ends: localInput(event ? new Date(event.ends_at) : new Date(start.getTime() + 3600_000)),
    location: event?.location ?? '',
    channel: event?.channel_id ?? '',
    description: event?.description ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body: EventInput = {
        title: form.title.trim(),
        starts_at: new Date(form.starts).toISOString(),
        ends_at: new Date(form.ends).toISOString(),
        location: form.location.trim(),
        description: form.description.trim(),
        channel_id: form.channel || null,
      };
      return event ? updateEvent(event.id, body) : createEvent(workspaceId, body);
    },
    onSuccess: onClose,
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('community.events.failed')),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {event ? t('community.events.edit') : t('community.events.new')}
          </DialogTitle>
          <DialogDescription>{t('community.events.hint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.title.trim()) save.mutate();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.title}>{t('community.events.title')}</Label>
            <Input
              id={ids.title}
              value={form.title}
              maxLength={200}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor={ids.start}>{t('community.events.starts')}</Label>
              <Input
                id={ids.start}
                type="datetime-local"
                value={form.starts}
                onChange={(e) => setForm({ ...form, starts: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.end}>{t('community.events.ends')}</Label>
              <Input
                id={ids.end}
                type="datetime-local"
                value={form.ends}
                min={form.starts}
                onChange={(e) => setForm({ ...form, ends: e.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.location}>{t('community.events.location')}</Label>
            <Input
              id={ids.location}
              value={form.location}
              maxLength={300}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.channel}>{t('community.events.channel')}</Label>
            <select
              id={ids.channel}
              className={selectClass}
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
            >
              <option value="">{t('community.events.noChannel')}</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.description}>{t('community.events.description')}</Label>
            <textarea
              id={ids.description}
              rows={3}
              maxLength={4000}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !form.title.trim()}>
              {t('community.events.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
