// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarIcon, MapPinIcon, PlusIcon } from 'lucide-react';
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
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full', timeStyle: 'short' });
  const time = new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' });
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
  return (
    <>
      {ws.workspace?.role !== 'guest' && (
        <Button className="self-start" onClick={() => setEditing('new')}>
          <PlusIcon strokeWidth={1.75} />
          {t('community.events.new')}
        </Button>
      )}
      {events.isPending ? (
        <Skeleton className="h-24" />
      ) : (events.data ?? []).length === 0 ? (
        <p role="status" className="py-8 text-center text-sm text-muted-foreground">
          {t('community.events.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.data!.map((e) => {
            const channel = channels.find((c) => c.id === e.channel_id);
            return (
              <li
                key={e.id}
                data-testid="event"
                className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm"
              >
                <h2 className="text-base font-semibold">{e.title}</h2>
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <CalendarIcon aria-hidden className="size-4" strokeWidth={1.75} />
                  {when.format(new Date(e.starts_at))} – {time.format(new Date(e.ends_at))}
                </p>
                {e.location && (
                  <p className="flex items-center gap-1.5 text-muted-foreground">
                    <MapPinIcon aria-hidden className="size-4" strokeWidth={1.75} />
                    {e.location}
                  </p>
                )}
                {channel && <p className="text-muted-foreground">#{channel.name}</p>}
                {e.description && <p className="whitespace-pre-line">{e.description}</p>}
                <p className="text-xs text-muted-foreground">
                  {t('community.events.going', { count: e.going.length })}
                  {e.going.length > 0 && `: ${e.going.map((g) => g.display_name).join(', ')}`}
                  {e.maybe > 0 && ` · ${t('community.events.maybeCount', { count: e.maybe })}`}
                </p>
                <div
                  role="group"
                  aria-label={t('community.events.answer')}
                  className="flex flex-wrap gap-1"
                >
                  {(['going', 'maybe', 'declined'] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={e.me === s ? 'secondary' : 'outline'}
                      aria-pressed={e.me === s}
                      disabled={answer.isPending}
                      onClick={() => answer.mutate({ e, status: e.me === s ? null : s })}
                    >
                      {t(`community.events.rsvp.${s}`)}
                    </Button>
                  ))}
                  {e.can_edit && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setEditing(e)}
                      >
                        {t('community.events.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(e)}
                      >
                        {t('community.events.cancel')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
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
