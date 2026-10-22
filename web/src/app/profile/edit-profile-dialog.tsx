// SPDX-License-Identifier: Apache-2.0
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, ImageUpIcon, Trash2Icon } from 'lucide-react';
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
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Avatar } from './avatar';
import {
  browserTimeZone,
  deleteAvatar,
  myProfileQuery,
  saved,
  updateMyProfile,
  uploadAvatar,
} from './profiles';

const MAX_UPLOAD = 5 * 1024 * 1024;

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** Your picture, @username, time zone and who sees when you were last online. */
export function EditProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = {
    name: useId(),
    username: useId(),
    tz: useId(),
    zones: useId(),
    error: useId(),
    lastSeen: useId(),
  };
  const me = useQuery(myProfileQuery);
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState(me.data?.username ?? '');
  const [timezone, setTimezone] = useState(me.data?.timezone || browserTimeZone());
  const [showLastSeen, setShowLastSeen] = useState(me.data?.show_last_seen ?? true);
  const zones = useMemo(() => timeZones(), []);

  const picture = useMutation({
    mutationFn: (f: File | null) => (f ? uploadAvatar(f) : deleteAvatar().then(() => null)),
    onSuccess: (profile) => {
      if (profile) saved(queryClient, profile);
      else {
        void queryClient.invalidateQueries({ queryKey: myProfileQuery.queryKey });
        if (me.data) void queryClient.invalidateQueries({ queryKey: ['profile', me.data.id] });
      }
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && (err.status === 422 || err.status === 413)
          ? t('profile.pictureInvalid')
          : t('profile.saveFailed'),
      ),
  });
  const save = useMutation({
    mutationFn: () =>
      updateMyProfile({
        ...(me.data?.username_editable && username !== me.data.username ? { username } : {}),
        timezone,
        show_last_seen: showLastSeen,
      }),
    onSuccess: (profile) => {
      saved(queryClient, profile);
      onOpenChange(false);
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const errorTitle =
    problem?.code === 'username_taken'
      ? t('profile.usernameTaken')
      : problem?.status === 400
        ? t('profile.invalid')
        : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD) {
      toast.error(t('profile.pictureTooLarge'));
      return;
    }
    picture.mutate(f);
  };
  const p = me.data;
  const here = browserTimeZone();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('profile.editTitle')}</DialogTitle>
            <DialogDescription>{t('profile.editDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-4">
            <Avatar name={p?.display_name ?? ''} profile={p ?? null} size="lg" />
            <div className="flex flex-col gap-2">
              <input
                ref={file}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={picture.isPending}
                aria-busy={picture.isPending || undefined}
                onClick={() => file.current?.click()}
              >
                <ImageUpIcon aria-hidden strokeWidth={1.75} />
                {p?.avatar_url ? t('profile.pictureChange') : t('profile.pictureUpload')}
              </Button>
              {p?.avatar_url && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={picture.isPending}
                  onClick={() => picture.mutate(null)}
                >
                  <Trash2Icon aria-hidden strokeWidth={1.75} />
                  {t('profile.pictureRemove')}
                </Button>
              )}
              <p className="text-xs text-muted-foreground">{t('profile.pictureHint')}</p>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>{t('profile.name')}</Label>
            <Input
              id={ids.name}
              value={p?.display_name ?? ''}
              readOnly
              aria-describedby={`${ids.name}-hint`}
            />
            <p id={`${ids.name}-hint`} className="text-xs text-muted-foreground">
              {t('profile.nameHint')}{' '}
              {p?.account_url && (
                <a
                  href={p.account_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-target items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {t('settings.openAccount')}
                  <ExternalLinkIcon aria-hidden className="size-3" strokeWidth={1.75} />
                  <span className="sr-only">{t('settings.newTab')}</span>
                </a>
              )}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.username}>{t('profile.username')}</Label>
            <div className="relative">
              <span
                aria-hidden
                className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
              >
                @
              </span>
              <Input
                id={ids.username}
                value={username}
                maxLength={30}
                autoComplete="off"
                spellCheck={false}
                className="pl-7"
                disabled={!p?.username_editable}
                aria-describedby={`${ids.username}-hint${save.isError ? ` ${ids.error}` : ''}`}
                aria-invalid={problem?.code === 'username_taken' || undefined}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
              />
            </div>
            <p id={`${ids.username}-hint`} className="text-xs text-muted-foreground">
              {p?.username_editable ? t('profile.usernameHint') : t('profile.usernameManaged')}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.tz}>{t('profile.timezone')}</Label>
            <Input
              id={ids.tz}
              value={timezone}
              list={ids.zones}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTimezone(e.target.value)}
            />
            <datalist id={ids.zones}>
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            {here && here !== timezone && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => setTimezone(here)}
              >
                {t('profile.timezoneHere', { zone: here })}
              </Button>
            )}
          </div>
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              id={ids.lastSeen}
              type="checkbox"
              checked={showLastSeen}
              onChange={(e) => setShowLastSeen(e.target.checked)}
              className="size-4 accent-primary"
              // The whole label is the target (at least 24 px).
              data-target-exempt
            />
            {t('profile.showLastSeen')}
          </label>
          {save.isError && (
            <InlineError id={ids.error} title={errorTitle} problem={problem ?? { status: 0 }} />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('glossary.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending || !p}>
              {t('chat.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
