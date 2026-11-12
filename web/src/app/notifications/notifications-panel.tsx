// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Label } from '@cenacle/ui/components/label';
import {
  deleteSound,
  FOREVER,
  isActive,
  notificationsQuery,
  savePrefs,
  setChannelNotifications,
  soundsQuery,
  untilOf,
  uploadSound,
  type NotificationPrefs,
} from './notifications';
import { canNotify } from './notifier';
import { disablePush, enablePush, pushSupported } from './push';
import { BUILTIN_SOUNDS, playSound } from './sounds';
import { dateLocale } from '../../i18n/time-format';
import { ChannelIcon } from '../chat/channel-icon';
import { channelsQuery } from '../chat/data';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const inputClass =
  'min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const PAUSES = ['30m', '1h', '2h', '8h', 'tomorrow'] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** Saves a change of the notification settings, showing it at once. */
function useSavePrefs() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: savePrefs,
    scope: { id: 'notification-prefs' },
    onError: () => {
      toast.error(t('notifications.saveFailed'));
      void queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey });
    },
  });
  return useCallback(
    (patch: Partial<NotificationPrefs>) => {
      const current = queryClient.getQueryData(notificationsQuery.queryKey);
      if (!current) return;
      const prefs = { ...current.prefs, ...patch };
      queryClient.setQueryData(notificationsQuery.queryKey, { ...current, prefs });
      mutate(prefs);
    },
    [queryClient, mutate],
  );
}

/** Sounds, desktop and push, pause, quiet hours and e-mail. */
export function NotificationsPanel() {
  const { t } = useTranslation();
  const ids = {
    level: useId(),
    volume: useId(),
    pause: useId(),
    start: useId(),
    end: useId(),
    delay: useId(),
    remind: useId(),
  };
  const settings = useQuery(notificationsQuery);
  const sounds = useQuery(soundsQuery);
  const save = useSavePrefs();
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  if (!settings.data) return null;
  const p = settings.data.prefs;
  const pushKey = settings.data.push_public_key;
  const paused = isActive(p.paused_until);
  // Servers before 1.0 have no call settings: these are theirs.
  const calls = p.calls ?? { ring: true, channel: true, sound: p.sounds.direct };
  const meetings = p.meetings ?? { remind_minutes: 10 as const, email: true };

  const soundOptions = (
    <>
      <option value="none">{t('notifications.sounds.none')}</option>
      {BUILTIN_SOUNDS.map((s) => (
        <option key={s} value={s}>
          {t(`notifications.sounds.${s}`)}
        </option>
      ))}
      {(sounds.data ?? []).length > 0 && (
        <optgroup label={t('notifications.yourSounds')}>
          {sounds.data!.map((s) => (
            <option key={s.id} value={`user:${s.id}`}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <div
      className="gap-x-10 pt-4 lg:columns-2 [&>section]:mb-7 [&>section]:break-inside-avoid [&>section]:content-start [&_section>h3]:border-b [&_section>h3]:pb-2 [&_section>h3]:font-semibold"
      data-testid="notifications-panel"
    >
      <section className="grid gap-2" aria-labelledby={`${ids.pause}-title`}>
        <h3 id={`${ids.pause}-title`} className="text-sm font-medium">
          {t('notifications.pause')}
        </h3>
        {paused ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {t('notifications.pausedUntil', {
                time: new Intl.DateTimeFormat(dateLocale(), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(p.paused_until!)),
              })}
            </span>
            <Button size="sm" variant="outline" onClick={() => save({ paused_until: null })}>
              {t('notifications.resume')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={ids.pause}>{t('notifications.pauseFor')}</Label>
            <select
              id={ids.pause}
              className={selectClass}
              value=""
              onChange={(e) =>
                e.target.value &&
                save({ paused_until: untilOf(e.target.value as (typeof PAUSES)[number]) })
              }
            >
              <option value="">{t('notifications.notPaused')}</option>
              {PAUSES.map((k) => (
                <option key={k} value={k}>
                  {t(`notifications.durations.${k}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids.level}-title`}>
        <h3 id={`${ids.level}-title`} className="text-sm font-medium">
          {t('notifications.what')}
        </h3>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.level}>{t('notifications.channelsDefault')}</Label>
          <select
            id={ids.level}
            className={selectClass}
            value={p.default_level}
            onChange={(e) =>
              save({ default_level: e.target.value as NotificationPrefs['default_level'] })
            }
          >
            {(['all', 'mentions', 'none'] as const).map((l) => (
              <option key={l} value={l}>
                {t(`notifications.levels.${l}`)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t('notifications.conversationsAlways')}</p>
        </div>
        <label data-target className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.desktop}
            onChange={(e) => {
              save({ desktop: e.target.checked });
              if (
                e.target.checked &&
                typeof Notification !== 'undefined' &&
                Notification.permission === 'default'
              ) {
                void Notification.requestPermission().then(setPermission);
              }
            }}
            className="size-4 accent-primary"
            data-target-exempt
          />
          {t('notifications.desktop')}
        </label>
        {p.desktop && permission === 'denied' && (
          <p className="text-xs text-muted-foreground">{t('notifications.desktopBlocked')}</p>
        )}
        {p.desktop && !canNotify() && permission !== 'denied' && permission !== 'unsupported' && (
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => void Notification.requestPermission().then(setPermission)}
          >
            {t('notifications.allow')}
          </Button>
        )}
        {pushKey && pushSupported() && (
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.push}
              onChange={(e) => {
                const on = e.target.checked;
                void (on ? enablePush(pushKey) : disablePush().then(() => true))
                  .then((ok) =>
                    ok ? save({ push: on }) : toast.error(t('notifications.pushDeclined')),
                  )
                  .catch(() => toast.error(t('notifications.saveFailed')));
              }}
              className="size-4 accent-primary"
              data-target-exempt
            />
            {t('notifications.push')}
          </label>
        )}
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids.volume}-title`}>
        <h3 id={`${ids.volume}-title`} className="text-sm font-medium">
          {t('notifications.soundsTitle')}
        </h3>
        {(['mention', 'direct', 'message'] as const).map((k) => (
          <SoundChoice
            key={k}
            label={t(`notifications.for.${k}`)}
            value={p.sounds[k]}
            volume={p.volume}
            options={soundOptions}
            onChange={(v) => save({ sounds: { ...p.sounds, [k]: v } })}
          />
        ))}
        <div className="grid gap-1.5">
          <Label htmlFor={ids.volume}>{t('notifications.volume', { volume: p.volume })}</Label>
          <input
            id={ids.volume}
            type="range"
            min={0}
            max={100}
            step={5}
            value={p.volume}
            onChange={(e) => save({ volume: Number(e.target.value) })}
            className="min-h-target accent-primary"
          />
        </div>
        <SoundUploads />
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids.volume}-calls`}>
        <h3 id={`${ids.volume}-calls`} className="text-sm font-medium">
          {t('notifications.calls.title')}
        </h3>
        <label data-target className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={calls.ring}
            onChange={(e) => save({ calls: { ...calls, ring: e.target.checked } })}
            className="size-4 accent-primary"
            data-target-exempt
          />
          {t('notifications.calls.ring')}
        </label>
        <label data-target className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={calls.channel}
            onChange={(e) => save({ calls: { ...calls, channel: e.target.checked } })}
            className="size-4 accent-primary"
            data-target-exempt
          />
          {t('notifications.calls.channel')}
        </label>
        <SoundChoice
          label={t('notifications.calls.sound')}
          value={calls.sound}
          volume={p.volume}
          options={soundOptions}
          onChange={(v) => save({ calls: { ...calls, sound: v } })}
        />
        <p className="text-xs text-muted-foreground">{t('notifications.calls.hint')}</p>
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids.remind}-title`}>
        <h3 id={`${ids.remind}-title`} className="text-sm font-medium">
          {t('notifications.meetings.title')}
        </h3>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.remind}>{t('notifications.meetings.remind')}</Label>
          <select
            id={ids.remind}
            className={selectClass}
            value={meetings.remind_minutes}
            onChange={(e) =>
              save({
                meetings: {
                  ...meetings,
                  remind_minutes: Number(e.target.value) as typeof meetings.remind_minutes,
                },
              })
            }
          >
            {([0, 5, 10, 15] as const).map((m) => (
              <option key={m} value={m}>
                {m === 0
                  ? t('notifications.meetings.noReminder')
                  : t('notifications.meetings.before', { count: m })}
              </option>
            ))}
          </select>
        </div>
        {settings.data.email_available && (
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={meetings.email}
              onChange={(e) => save({ meetings: { ...meetings, email: e.target.checked } })}
              className="size-4 accent-primary"
              data-target-exempt
            />
            {t('notifications.meetings.email')}
          </label>
        )}
        <p className="text-xs text-muted-foreground">{t('notifications.meetings.hint')}</p>
      </section>

      <section className="grid gap-3" aria-labelledby={`${ids.start}-title`}>
        <h3 id={`${ids.start}-title`} className="text-sm font-medium">
          {t('notifications.quietHours')}
        </h3>
        <label data-target className="flex min-h-target items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.quiet_hours.enabled}
            onChange={(e) => save({ quiet_hours: { ...p.quiet_hours, enabled: e.target.checked } })}
            className="size-4 accent-primary"
            data-target-exempt
          />
          {t('notifications.quietHoursOn')}
        </label>
        {p.quiet_hours.enabled && (
          <>
            <div className="flex flex-wrap gap-3">
              <div className="grid gap-1">
                <Label htmlFor={ids.start}>{t('notifications.from')}</Label>
                <input
                  id={ids.start}
                  type="time"
                  value={p.quiet_hours.start}
                  className={inputClass}
                  onChange={(e) =>
                    e.target.value &&
                    save({ quiet_hours: { ...p.quiet_hours, start: e.target.value } })
                  }
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor={ids.end}>{t('notifications.to')}</Label>
                <input
                  id={ids.end}
                  type="time"
                  value={p.quiet_hours.end}
                  className={inputClass}
                  onChange={(e) =>
                    e.target.value &&
                    save({ quiet_hours: { ...p.quiet_hours, end: e.target.value } })
                  }
                />
              </div>
            </div>
            <fieldset className="flex flex-wrap gap-1">
              <legend className="mb-1 text-sm">{t('notifications.days')}</legend>
              {DAYS.map((d) => {
                const on = p.quiet_hours.days.includes(d);
                return (
                  <label
                    key={d}
                    data-target
                    className="flex min-h-target items-center gap-1.5 rounded-md border px-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        save({
                          quiet_hours: {
                            ...p.quiet_hours,
                            days: on
                              ? p.quiet_hours.days.filter((x) => x !== d)
                              : [...p.quiet_hours.days, d],
                          },
                        })
                      }
                      className="size-4 accent-primary"
                      data-target-exempt
                    />
                    {t(`notifications.weekdays.${d}`)}
                  </label>
                );
              })}
            </fieldset>
          </>
        )}
      </section>

      {settings.data.email_available && (
        <section className="grid gap-2" aria-labelledby={`${ids.delay}-title`}>
          <h3 id={`${ids.delay}-title`} className="text-sm font-medium">
            {t('notifications.email')}
          </h3>
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.email.enabled}
              onChange={(e) => save({ email: { ...p.email, enabled: e.target.checked } })}
              className="size-4 accent-primary"
              data-target-exempt
            />
            {t('notifications.emailOn')}
          </label>
          {p.email.enabled && (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.delay}>{t('notifications.emailAfter')}</Label>
              <select
                id={ids.delay}
                className={selectClass}
                value={p.email.delay_minutes}
                onChange={(e) =>
                  save({
                    email: { ...p.email, delay_minutes: Number(e.target.value) as 5 | 15 | 60 },
                  })
                }
              >
                {[5, 15, 60].map((m) => (
                  <option key={m} value={m}>
                    {t('notifications.minutes', { count: m })}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>
      )}
      <ChannelExceptions />
    </div>
  );
}

/** Channels whose notifications differ from the defaults, set in the channel details panel. */
function ChannelExceptions() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery(notificationsQuery);
  const channels = useQuery(channelsQuery).data ?? [];
  const reset = useMutation({
    mutationFn: (channelId: string) =>
      setChannelNotifications(channelId, { level: 'default', muted_until: null, sound: '' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationsQuery.queryKey }),
    onError: () => toast.error(t('notifications.saveFailed')),
  });
  const until = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const rows = (settings.data?.channels ?? []).filter(
    (c) => c.level !== 'default' || isActive(c.muted_until) || c.sound !== '',
  );
  const describe = (c: (typeof rows)[number]) => {
    if (isActive(c.muted_until))
      return c.muted_until === FOREVER
        ? t('notifications.exceptions.mutedForever')
        : t('notifications.exceptions.mutedUntil', {
            time: until.format(new Date(c.muted_until!)),
          });
    if (c.level !== 'default') return t(`notifications.levels.${c.level}`);
    return t('notifications.exceptions.ownSound');
  };
  return (
    <section
      className="grid content-start gap-2 lg:col-start-2"
      aria-labelledby="notification-exceptions"
    >
      <h3 className="flex items-baseline gap-2 text-sm">
        <span id="notification-exceptions">{t('notifications.exceptions.title')}</span>
        <span className="text-xs font-normal text-muted-foreground">
          {t('notifications.exceptions.hint')}
        </span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('notifications.exceptions.none')}</p>
      ) : (
        <ul
          data-testid="notification-exceptions"
          className="divide-y rounded-[10px] border border-rule-strong bg-background"
        >
          {rows.map((c) => {
            const channel = channels.find((x) => x.id === c.channel_id);
            const name = channel?.name ?? t('notifications.exceptions.unknownChannel');
            return (
              <li key={c.channel_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                {channel && (
                  <ChannelIcon
                    channel={channel}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                <span className="text-muted-foreground">{describe(c)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('notifications.exceptions.resetNamed', { channel: name })}
                  disabled={reset.isPending}
                  onClick={() => reset.mutate(c.channel_id)}
                >
                  {t('notifications.exceptions.reset')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SoundChoice({
  label,
  value,
  volume,
  options,
  onChange,
}: {
  label: string;
  value: string;
  volume: number;
  options: React.ReactNode;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <select
          id={id}
          className={selectClass}
          value={value}
          onChange={(e) => {
            // Choosing is hearing: a sound plays as it is picked.
            onChange(e.target.value);
            if (e.target.value !== 'none') playSound(e.target.value, volume);
          }}
        >
          {options}
        </select>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={t('notifications.preview', { what: label })}
          disabled={value === 'none'}
          onClick={() => playSound(value, volume)}
        >
          <PlayIcon strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

const MAX_SOUND = 1024 * 1024;

function SoundUploads() {
  const { t } = useTranslation();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<File | null>(null);
  const sounds = useQuery(soundsQuery);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: soundsQuery.queryKey });
  const upload = useMutation({
    mutationFn: (f: File) => uploadSound(name.trim() || f.name.replace(/\.[^.]+$/, ''), f),
    onSuccess: () => {
      setName('');
      setPicked(null);
      void refresh();
      toast.success(t('notifications.soundAdded'));
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.problem.code === 'sound_limit'
          ? t('notifications.soundLimit')
          : t('notifications.soundInvalid'),
      ),
  });
  const remove = useMutation({ mutationFn: deleteSound, onSuccess: refresh });
  return (
    <div className="grid gap-2" data-testid="sound-uploads">
      {(sounds.data ?? []).length > 0 && (
        <ul className="grid gap-1">
          {sounds.data!.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{s.name}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('notifications.soundRemove', { name: s.name })}
                onClick={() => remove.mutate(s.id)}
              >
                <Trash2Icon strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {picked ? (
        // The file first, then its name (taken from the file, to change if wanted).
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate(picked);
          }}
        >
          <div className="grid min-w-40 flex-1 gap-1">
            <Label htmlFor={`${id}-name`}>{t('notifications.soundName')}</Label>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={60}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the next step of the action just taken
              autoFocus
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} w-full min-w-0`}
            />
          </div>
          <Button type="button" variant="ghost" onClick={() => setPicked(null)}>
            {t('ui:confirm.cancel')}
          </Button>
          <Button type="submit" disabled={upload.isPending}>
            {t('notifications.soundAdd')}
          </Button>
        </form>
      ) : (
        <div>
          <input
            ref={file}
            type="file"
            accept="audio/mpeg,audio/ogg,audio/wav,audio/webm,.mp3,.ogg,.wav,.webm"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > MAX_SOUND) {
                toast.error(t('notifications.soundInvalid'));
                return;
              }
              setName(f.name.replace(/\.[^.]+$/, '').slice(0, 60));
              setPicked(f);
            }}
          />
          <Button type="button" variant="outline" onClick={() => file.current?.click()}>
            <UploadIcon aria-hidden strokeWidth={1.75} />
            {t('notifications.soundUpload')}
          </Button>
        </div>
      )}
    </div>
  );
}
