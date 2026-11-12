// SPDX-License-Identifier: AGPL-3.0-only
import { useDeferredValue, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import {
  channelsQuery,
  isConversation,
  membersQuery,
  peopleQuery,
  reloadChannels,
  type Channel,
} from '../chat/data';
import {
  addDays,
  createMeeting,
  dateInput,
  defaultRepeat,
  fromInputs,
  fromRule,
  meetingsChanged,
  timeInput,
  toRule,
  updateMeeting,
  WEEKDAYS,
  weekdayOf,
  type Meeting,
  type Repeat,
} from './data';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Invitees a meeting may have (the server's limit). */
const MAX_INVITEES = 50;
/** A meeting in a new conversation: its people (the conversation's limit). */
const MAX_CONVERSATION = 8;

interface Invitee {
  id: string;
  name: string;
}

/** The channels where a meeting's call can happen. */
const callable = (c: Channel) => c.can_post && !c.archived && !c.encrypted && !c.mls;

/**
 * Plans a meeting or changes one: when, how it repeats, where its call
 * happens and who is invited. From a channel, the meeting is in it.
 */
export function MeetingDialog({
  workspaceId,
  channel,
  meeting,
  start: initialStart,
  onClose,
}: {
  workspaceId: string;
  /** The channel it is planned from (fixed). */
  channel?: Channel;
  /** The meeting to change. */
  meeting?: Meeting;
  start?: Date;
  onClose: (saved?: Meeting) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const channels = (useQuery(channelsQuery).data ?? []).filter(
    (c) => c.workspace_id === workspaceId && callable(c),
  );
  const [start] = useState(() => {
    if (meeting) return new Date(meeting.starts_at);
    if (initialStart) return initialStart;
    const d = new Date(Date.now() + 3600_000);
    d.setMinutes(0, 0, 0);
    return d;
  });
  const end = meeting ? new Date(meeting.ends_at) : new Date(start.getTime() + 30 * 60_000);
  const [form, setForm] = useState({
    title: meeting?.title ?? '',
    date: dateInput(start),
    from: timeInput(start),
    to: timeInput(end),
    agenda: meeting?.agenda ?? '',
    // '' for a conversation with the invitees.
    place: meeting?.channel_id ?? channel?.id ?? '',
  });
  const [repeat, setRepeat] = useState<Repeat>(() =>
    meeting ? fromRule(meeting.rrule, start) : defaultRepeat(start),
  );
  const [picked, setPicked] = useState<Invitee[]>(
    () =>
      meeting?.invitees
        .filter((i) => !i.organizer)
        .map((i) => ({ id: i.user_id, name: i.display_name })) ?? [],
  );
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLocaleLowerCase());
  const placeChannel = form.place ? channels.find((c) => c.id === form.place) : undefined;
  const members = useQuery({ ...membersQuery(form.place), enabled: !!form.place });
  const people = useQuery({
    ...peopleQuery(workspaceId, query),
    enabled: !form.place && query !== '',
  });
  const limit = form.place ? MAX_INVITEES : MAX_CONVERSATION;
  const candidates: Invitee[] = (
    form.place
      ? (members.data ?? [])
          .filter((m) => !m.user.is_bot)
          .map((m) => ({ id: m.user.id, name: m.user.display_name || m.user.email }))
          .filter((m) => query === '' || m.name.toLocaleLowerCase().includes(query))
      : (people.data ?? []).map((p) => ({ id: p.id, name: p.display_name || p.email }))
  ).filter(
    (p) => p.id !== self && p.id !== meeting?.organizer_id && !picked.some((x) => x.id === p.id),
  );
  const everyone: Invitee[] = form.place
    ? (members.data ?? [])
        .filter((m) => !m.user.is_bot && m.user.id !== self && m.user.id !== meeting?.organizer_id)
        .map((m) => ({ id: m.user.id, name: m.user.display_name || m.user.email }))
    : [];

  const startsAt = fromInputs(form.date, form.from);
  let endsAt = fromInputs(form.date, form.to);
  // An end before the start is on the next day (a meeting past midnight).
  if (endsAt <= startsAt) endsAt = addDays(endsAt, 1);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        title: form.title.trim(),
        agenda: form.agenda.trim(),
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        timezone: zone,
        rrule: toRule(repeat, startsAt),
        user_ids: picked.map((p) => p.id),
      };
      if (meeting) return updateMeeting(meeting.id, body);
      const saved = await createMeeting({
        ...body,
        workspace_id: workspaceId,
        channel_id: form.place || null,
      });
      // A new conversation shows in the sidebar.
      if (!form.place) await reloadChannels(queryClient);
      return saved;
    },
    onSuccess: (saved) => {
      meetingsChanged(queryClient, saved.id);
      onClose(saved);
    },
  });
  const valid =
    form.title.trim() !== '' &&
    !!form.date &&
    !!form.from &&
    !!form.to &&
    (form.place !== '' || picked.length > 0) &&
    (repeat.freq !== 'weekly' || repeat.days.length > 0);

  const pick = (p: Invitee) => {
    if (picked.length >= limit) return;
    setPicked([...picked, p]);
    setQ('');
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{meeting ? t('meetings.edit') : t('meetings.new')}</DialogTitle>
          <DialogDescription>{t('meetings.form.hint', { zone })}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-title`}>{t('meetings.form.title')}</Label>
            <Input
              id={`${id}-title`}
              value={form.title}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-2 max-sm:grid-cols-2">
            <div className="grid gap-1.5 max-sm:col-span-2">
              <Label htmlFor={`${id}-date`}>{t('meetings.form.date')}</Label>
              <Input
                id={`${id}-date`}
                type="date"
                value={form.date}
                onChange={(e) => {
                  const date = e.target.value;
                  setForm({ ...form, date });
                  // A weekly repeat on the old day moves with the date.
                  const was = weekdayOf(fromInputs(form.date, '12:00'));
                  if (date && repeat.days.length === 1 && repeat.days[0] === was) {
                    setRepeat({ ...repeat, days: [weekdayOf(fromInputs(date, '12:00'))] });
                  }
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-from`}>{t('meetings.form.starts')}</Label>
              <Input
                id={`${id}-from`}
                type="time"
                step={300}
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-to`}>{t('meetings.form.ends')}</Label>
              <Input
                id={`${id}-to`}
                type="time"
                step={300}
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            </div>
          </div>
          <RepeatFields id={id} repeat={repeat} onChange={setRepeat} />

          {!meeting && !channel && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-place`}>{t('meetings.form.where')}</Label>
              <select
                id={`${id}-place`}
                className={selectClass}
                value={form.place}
                onChange={(e) => {
                  setForm({ ...form, place: e.target.value });
                  setPicked([]);
                }}
              >
                <option value="">{t('meetings.form.newConversation')}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {isConversation(c) ? c.name : t('meetings.form.inChannel', { name: c.name })}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {form.place
                  ? t('meetings.form.placeHint')
                  : t('meetings.form.conversationHint', { count: MAX_CONVERSATION })}
              </p>
            </div>
          )}
          {(meeting || channel) && placeChannel && (
            <p className="text-sm text-muted-foreground">
              {t('meetings.form.callIn', { place: placeChannel.name })}
            </p>
          )}

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t('meetings.form.people')}</legend>
            {picked.length > 0 && (
              <ul aria-label={t('meetings.form.picked')} className="flex flex-wrap gap-1.5">
                {picked.map((p) => (
                  <li key={p.id}>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label={t('meetings.form.unpick', { person: p.name })}
                      onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                    >
                      {p.name}
                      <XIcon aria-hidden strokeWidth={1.75} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <div className="grid min-w-0 flex-1 gap-1">
                <Label htmlFor={`${id}-find`} className="sr-only">
                  {t('meetings.form.find')}
                </Label>
                <Input
                  id={`${id}-find`}
                  type="search"
                  value={q}
                  autoComplete="off"
                  placeholder={t('meetings.form.find')}
                  disabled={picked.length >= limit}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              {form.place && everyone.length > 0 && everyone.length <= MAX_INVITEES && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={everyone.every((m) => picked.some((p) => p.id === m.id))}
                  onClick={() => setPicked(everyone)}
                >
                  {t('meetings.form.everyone', { count: everyone.length })}
                </Button>
              )}
            </div>
            {(query !== '' || form.place) && (
              <ul aria-live="polite" className="-mx-1 grid max-h-44 gap-0.5 overflow-y-auto">
                {candidates.slice(0, 30).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="flex min-h-target w-full items-center rounded-md px-2 text-start text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                      aria-label={t('meetings.form.pick', { person: p.name })}
                      onClick={() => pick(p)}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
                {query !== '' && candidates.length === 0 && (
                  <li className="px-2 text-sm text-muted-foreground">{t('channels.noPeople')}</li>
                )}
              </ul>
            )}
            {picked.length >= limit && (
              <p className="text-xs text-muted-foreground">
                {t('meetings.form.full', { count: limit })}
              </p>
            )}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-agenda`}>{t('meetings.form.agenda')}</Label>
            <textarea
              id={`${id}-agenda`}
              rows={3}
              maxLength={4000}
              value={form.agenda}
              onChange={(e) => setForm({ ...form, agenda: e.target.value })}
              className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          {save.isError && (
            <InlineError
              problem={save.error instanceof ApiError ? save.error.problem : { status: 500 }}
            />
          )}
          <DialogFooter className="sticky bottom-0">
            <Button type="button" variant="outline" onClick={() => onClose()}>
              {t('ui:confirm.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!valid || save.isPending}
              aria-busy={save.isPending || undefined}
            >
              {meeting ? t('meetings.form.saveChanges') : t('meetings.form.plan')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepeatFields({
  id,
  repeat,
  onChange,
}: {
  id: string;
  repeat: Repeat;
  onChange: (r: Repeat) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<Repeat>) => onChange({ ...repeat, ...patch });
  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-repeat`}>{t('meetings.form.repeat')}</Label>
        <select
          id={`${id}-repeat`}
          className={selectClass}
          value={repeat.freq}
          onChange={(e) => set({ freq: e.target.value as Repeat['freq'], interval: 1 })}
        >
          {(['none', 'daily', 'weekly', 'monthly'] as const).map((f) => (
            <option key={f} value={f}>
              {t(`meetings.freq.${f}`)}
            </option>
          ))}
        </select>
      </div>
      {repeat.freq !== 'none' && (
        <div className="grid gap-3 rounded-[10px] border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Label htmlFor={`${id}-interval`}>{t('meetings.form.every')}</Label>
            <Input
              id={`${id}-interval`}
              type="number"
              min={1}
              max={12}
              value={repeat.interval}
              className="w-20"
              onChange={(e) =>
                set({ interval: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })
              }
            />
            <span>{t(`meetings.unit.${repeat.freq}`, { count: repeat.interval })}</span>
          </div>
          {repeat.freq === 'weekly' && (
            <fieldset>
              <legend className="mb-1.5 text-sm">{t('meetings.form.onDays')}</legend>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS.map((d) => {
                  const on = repeat.days.includes(d);
                  return (
                    <Button
                      key={d}
                      type="button"
                      size="sm"
                      variant={on ? 'secondary' : 'outline'}
                      aria-pressed={on}
                      className={cn('min-w-11', on && 'border-accent-brand')}
                      onClick={() =>
                        set({ days: on ? repeat.days.filter((x) => x !== d) : [...repeat.days, d] })
                      }
                    >
                      <span aria-hidden>{t(`meetings.days.short.${d}`)}</span>
                      <span className="sr-only">{t(`meetings.days.long.${d}`)}</span>
                    </Button>
                  );
                })}
              </div>
            </fieldset>
          )}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm">{t('meetings.form.endsRepeat')}</legend>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label data-target className="flex min-h-target items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-end`}
                  checked={repeat.end === 'until'}
                  onChange={() => set({ end: 'until' })}
                  className="size-4 accent-primary"
                  data-target-exempt
                />
                {t('meetings.form.endsOn')}
              </label>
              <Input
                type="date"
                aria-label={t('meetings.form.endsOnDate')}
                value={repeat.until}
                disabled={repeat.end !== 'until'}
                className="w-44"
                onChange={(e) => set({ until: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label data-target className="flex min-h-target items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-end`}
                  checked={repeat.end === 'count'}
                  onChange={() => set({ end: 'count' })}
                  className="size-4 accent-primary"
                  data-target-exempt
                />
                {t('meetings.form.endsAfter')}
              </label>
              <Input
                type="number"
                min={1}
                max={400}
                aria-label={t('meetings.form.endsAfterCount')}
                value={repeat.count}
                disabled={repeat.end !== 'count'}
                className="w-20"
                onChange={(e) =>
                  set({ count: Math.min(400, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
              <span>{t('meetings.form.times', { count: repeat.count })}</span>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
