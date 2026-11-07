// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { CopyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Logo } from '@cenacle/ui/brand';
import { Button } from '@cenacle/ui/components/button';
import { ErrorState, InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { dateLocale } from '../../i18n/time-format';
import type { Channel } from './data';

type GuestLink = components['schemas']['GuestLink'];
type Preview = components['schemas']['GuestLinkPreview'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const EXPIRY_HOURS = [1, 24, 168, 720] as const;

const linksQuery = (channelId: string) => ({
  queryKey: ['guest-links', channelId],
  queryFn: () =>
    apiFetch<{ links: GuestLink[] }>(`/api/channels/${channelId}/guest-links`).then((r) => r.links),
});

/** The address someone from outside opens. */
const guestURL = (token: string) => `${window.location.origin}/guest/${token}`;

/** A channel's guest links: create one (shown once), see who came, revoke. */
export function GuestLinksSection({ channel }: { channel: Channel }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const links = useQuery(linksQuery(channel.id));
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [hours, setHours] = useState<number>(24);
  const [maxUses, setMaxUses] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: ['guest-links', channel.id] });
  const create = useMutation({
    mutationFn: () =>
      apiFetch<{ link: GuestLink; token: string }>(
        `/api/channels/${channel.id}/guest-links`,
        json({
          name: name.trim(),
          password,
          expires_in_hours: hours,
          ...(Number(maxUses) > 0 ? { max_uses: Number(maxUses) } : {}),
        }),
      ),
    onSuccess: (r) => {
      setCreated(guestURL(r.token));
      setName('');
      setPassword('');
      void reload();
    },
  });
  const revoke = useMutation({
    mutationFn: (linkId: string) =>
      apiFetch<void>(`/api/channels/${channel.id}/guest-links/${linkId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void reload();
      toast.success(t('guestLinks.revoked'));
    },
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const time = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password.length >= 8) create.mutate();
  };
  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t('guestLinks.copied')))
      .catch(() => toast.error(t('guestLinks.copyFailed')));
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid gap-3 border-t pt-4"
      data-testid="guest-links"
    >
      <div className="grid gap-1">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('guestLinks.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('guestLinks.hint')}</p>
      </div>
      {created && (
        <div className="grid gap-1.5" data-testid="guest-link-created">
          <Label htmlFor={`${id}-created`}>{t('guestLinks.created')}</Label>
          <div className="flex gap-2">
            <Input id={`${id}-created`} readOnly value={created} className="text-xs" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t('guestLinks.copy')}
              onClick={() => void copy(created)}
            >
              <CopyIcon aria-hidden strokeWidth={1.75} />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('guestLinks.createdHint')}</p>
        </div>
      )}
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-name`}>{t('guestLinks.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-password`}>{t('guestLinks.password')}</Label>
          <Input
            id={`${id}-password`}
            type="password"
            value={password}
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
            aria-describedby={`${id}-password-hint`}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p id={`${id}-password-hint`} className="text-xs text-muted-foreground">
            {t('guestLinks.passwordHint')}
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-hours`}>{t('guestLinks.expires')}</Label>
          <select
            id={`${id}-hours`}
            className="min-h-target h-9 rounded-md border bg-background px-2 text-sm"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {EXPIRY_HOURS.map((h) => (
              <option key={h} value={h}>
                {t(`guestLinks.hours.${h}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-uses`}>{t('guestLinks.maxUses')}</Label>
          <Input
            id={`${id}-uses`}
            type="number"
            min={1}
            max={1000}
            inputMode="numeric"
            placeholder={t('guestLinks.unlimited')}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </div>
        {create.isError && (
          <div className="sm:col-span-2">
            <InlineError
              problem={create.error instanceof ApiError ? create.error.problem : { status: 0 }}
            />
          </div>
        )}
        <div className="sm:col-span-2">
          <Button
            type="submit"
            variant="outline"
            disabled={create.isPending || password.length < 8}
          >
            {t('guestLinks.create')}
          </Button>
        </div>
      </form>
      {(links.data ?? []).length > 0 && (
        <ul className="grid gap-1.5" data-testid="guest-link-list">
          {links.data!.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="font-medium">{l.name || t('guestLinks.unnamed')}</span>
              <span className="text-xs text-muted-foreground">
                {t('guestLinks.until', { time: time.format(new Date(l.expires_at)) })} ·{' '}
                {t('guestLinks.guests', { count: l.guests })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ms-auto"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(l.id)}
              >
                {t('guestLinks.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** /guest/<token>: someone from outside joins the link's channel. */
export function GuestPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { token } = useParams({ from: '/guest/$token' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ['guest-link', token],
    queryFn: () => apiFetch<Preview>(`/api/guest-links/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const join = useMutation({
    mutationFn: () =>
      apiFetch<{ channel_id: string }>(`/api/guest-links/${token}`, json({ name, password })),
    onSuccess: async ({ channel_id }) => {
      await queryClient.invalidateQueries();
      void navigate({ to: '/c/$channelId', params: { channelId: channel_id }, replace: true });
    },
  });
  const problem = join.error instanceof ApiError ? join.error.problem : undefined;
  const errorTitle =
    problem?.code === 'wrong_password'
      ? t('guestLinks.wrongPassword')
      : problem?.code === 'guest_link_invalid'
        ? t('guestLinks.invalidTitle')
        : undefined;
  const expires = preview.data
    ? new Intl.DateTimeFormat(dateLocale(i18n.language), {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(preview.data.expires_at))
    : '';
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo variant="lockup" size={28} />
        {preview.isPending ? null : preview.isError || !preview.data.valid ? (
          <ErrorState
            title={t('guestLinks.invalidTitle')}
            reason={t('guestLinks.invalidReason')}
            action={t('guestLinks.askAgain')}
            code="guest_link_invalid"
          />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              join.mutate();
            }}
          >
            <div className="flex flex-col gap-2">
              <h1 className="font-display text-3xl font-medium">
                {t('guestLinks.joinTitle', { channel: preview.data.channel_name })}
              </h1>
              <p className="text-muted-foreground">
                {t('guestLinks.joinSubtitle', {
                  workspace: preview.data.workspace_name,
                  time: expires,
                })}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('guestLinks.yourName')}</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={80}
                required
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-password`}>{t('guestLinks.password')}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                value={password}
                required
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {problem && <InlineError title={errorTitle} problem={problem} />}
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full text-base"
              disabled={join.isPending || name.trim() === '' || password === ''}
            >
              {t('guestLinks.join')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('guestLinks.joinNote')}</p>
          </form>
        )}
      </div>
    </main>
  );
}
