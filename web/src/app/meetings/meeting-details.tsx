// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarArrowDownIcon, PhoneIcon, RepeatIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button, buttonVariants } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { ErrorState } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { channelsQuery } from '../chat/data';
import { joinMeeting } from './join';
import { dateLocale } from '../../i18n/time-format';
import {
  answerMeeting,
  cancelMeeting,
  joinable,
  meetingFileURL,
  meetingQuery,
  meetingsChanged,
  skipOccurrence,
  type Answer,
  type Meeting,
} from './data';
import { MeetingDialog } from './meeting-dialog';
import { repeatText } from './repeat-text';

const ANSWERS: Answer[] = ['yes', 'maybe', 'no'];

/** One meeting: when, where, who, your answer, and Join when it is time. */
export function MeetingDetails({
  id,
  occurrence,
  onClose,
}: {
  id: string;
  /** The occurrence opened from the calendar (its start and end). */
  occurrence?: { start: Date; end: Date };
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const meeting = useQuery(meetingQuery(id));
  const channels = useQuery(channelsQuery).data ?? [];
  const self = useSession().user.id;
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'all' | 'one' | null>(null);
  const m = meeting.data;

  const answer = useMutation({
    mutationFn: (a: Answer) => answerMeeting(id, a),
    onSuccess: () => meetingsChanged(queryClient, id),
    onError: () => toast.error(t('meetings.failed')),
  });

  if (editing && m)
    return (
      <MeetingDialog workspaceId={m.workspace_id} meeting={m} onClose={() => setEditing(false)} />
    );

  const start = occurrence?.start ?? (m ? new Date(m.starts_at) : new Date());
  const end = occurrence?.end ?? (m ? new Date(m.ends_at) : new Date());
  const locale = dateLocale(i18n.language);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(start);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const place = m && channels.find((c) => c.id === m.channel_id);
  const canJoin = m && !m.cancelled && place && joinable(start, end);
  const repeats = m?.rrule ? repeatText(t, m.rrule, new Date(m.starts_at), locale) : '';

  const join = () => {
    if (!m || !place) return;
    onClose();
    void joinMeeting(queryClient, place.id, m.title, self);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg" data-testid="meeting">
        {meeting.isPending && (
          <>
            <DialogTitle className="sr-only">{t('meetings.loading')}</DialogTitle>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24" />
          </>
        )}
        {meeting.isError && (
          <>
            <DialogTitle className="sr-only">{t('meetings.title')}</DialogTitle>
            <ErrorState
              problem={meeting.error instanceof ApiError ? meeting.error.problem : { status: 500 }}
              actions={
                <Button onClick={() => void meeting.refetch()}>{t('ui:errors.retry')}</Button>
              }
            />
          </>
        )}
        {m && (
          <>
            <DialogHeader>
              <DialogTitle className={cn('text-lg', m.cancelled && 'text-muted-foreground')}>
                {m.title}
                {m.cancelled && (
                  <span className="ms-2 inline-block rounded-full bg-muted px-2 py-0.5 align-middle text-xs font-semibold text-foreground">
                    {t('meetings.cancelled')}
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="flex flex-col gap-0.5 tabular-nums">
                <span className="text-foreground">
                  {day}, {time.format(start)} – {time.format(end)}
                </span>
                {repeats && (
                  <span className="flex items-center gap-1.5">
                    <RepeatIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                    {repeats}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>

            {!m.cancelled && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={!canJoin}
                  aria-describedby={canJoin ? undefined : `${id}-join-hint`}
                  onClick={join}
                >
                  <PhoneIcon aria-hidden strokeWidth={1.75} />
                  {t('meetings.join')}
                </Button>
                {!canJoin && (
                  <span id={`${id}-join-hint`} className="text-xs text-muted-foreground">
                    {t('meetings.joinHint')}
                  </span>
                )}
              </div>
            )}

            <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2.5 border-t pt-3 text-sm max-sm:grid-cols-1">
              <dt className="text-muted-foreground">{t('meetings.where')}</dt>
              <dd className="min-w-0">
                {place ? (
                  <Link
                    to="/c/$channelId"
                    params={{ channelId: place.id }}
                    onClick={onClose}
                    className="underline underline-offset-2"
                  >
                    {t('meetings.callIn', { place: place.name })}
                  </Link>
                ) : (
                  t('meetings.placeUnknown')
                )}
              </dd>
              <dt className="text-muted-foreground">{t('meetings.invited')}</dt>
              <dd className="min-w-0">
                <ul className="grid gap-1">
                  {m.invitees.map((i) => (
                    <li key={i.user_id} className="flex flex-wrap items-baseline gap-x-2">
                      <span>{i.display_name}</span>
                      <span className="text-xs text-muted-foreground">
                        {i.organizer
                          ? t('meetings.organizer')
                          : t(`meetings.answers.${i.response}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
              {m.agenda && (
                <>
                  <dt className="text-muted-foreground">{t('meetings.agenda')}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words">{m.agenda}</dd>
                </>
              )}
            </dl>

            {!m.cancelled && m.organizer_id !== self && (
              <div
                role="group"
                aria-labelledby={`${id}-answer`}
                className="grid gap-2 border-t pt-3"
              >
                <p id={`${id}-answer`} className="text-sm font-medium">
                  {t('meetings.yourAnswer')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ANSWERS.map((a) => {
                    const on = m.my_response === a;
                    return (
                      <Button
                        key={a}
                        size="sm"
                        variant={on ? 'secondary' : 'outline'}
                        aria-pressed={on}
                        className={cn(on && 'border-accent-brand')}
                        disabled={answer.isPending}
                        onClick={() => answer.mutate(a)}
                      >
                        {t(`meetings.answer.${a}`)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            <DialogFooter className="flex-wrap gap-2 border-t pt-3 sm:justify-start">
              <a
                href={meetingFileURL(m.id)}
                download={`${m.title}.ics`}
                className={buttonVariants({ variant: 'outline' })}
              >
                <CalendarArrowDownIcon aria-hidden strokeWidth={1.75} />
                {t('meetings.download')}
              </a>
              {m.can_edit && (
                <>
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    {t('meetings.change')}
                  </Button>
                  {m.rrule && occurrence && (
                    <Button variant="outline" onClick={() => setConfirm('one')}>
                      {t('meetings.cancelOne')}
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setConfirm('all')}>
                    {m.rrule ? t('meetings.cancelAll') : t('meetings.cancelMeeting')}
                  </Button>
                </>
              )}
            </DialogFooter>
            <CancelConfirm
              meeting={m}
              which={confirm}
              occurrence={start}
              day={day}
              onDone={(cancelled) => {
                setConfirm(null);
                if (cancelled) {
                  meetingsChanged(queryClient, m.id);
                  onClose();
                }
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelConfirm({
  meeting,
  which,
  occurrence,
  day,
  onDone,
}: {
  meeting: Meeting;
  which: 'all' | 'one' | null;
  occurrence: Date;
  day: string;
  onDone: (cancelled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={which !== null}
      onOpenChange={(open) => !open && onDone(false)}
      severity="s2"
      title={
        which === 'one'
          ? t('meetings.confirmOne.title', { day })
          : t('meetings.confirmAll.title', { title: meeting.title })
      }
      description={
        which === 'one'
          ? t('meetings.confirmOne.description')
          : t('meetings.confirmAll.description')
      }
      confirmLabel={which === 'one' ? t('meetings.cancelOne') : t('meetings.cancelMeeting')}
      cancelLabel={t('meetings.keep')}
      onConfirm={async () => {
        if (which === 'one') await skipOccurrence(meeting.id, occurrence.toISOString());
        else await cancelMeeting(meeting.id);
        toast.success(which === 'one' ? t('meetings.cancelledOne') : t('meetings.cancelledAll'));
        onDone(true);
      }}
    />
  );
}
