// SPDX-License-Identifier: AGPL-3.0-only
import { DownloadIcon, ShieldAlertIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { dateLocale } from '../../i18n/time-format';
import type { Message } from '../chat/data';
import { plainText } from '../search/search';
import { reloadWorkspaces, workspaceMembersQuery, type Workspace } from '../chat/workspaces';

type Report = components['schemas']['SpillageReport'];

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Reporting that a message holds what must not be here. */
export function SpillageReportDialog({
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
    mutationFn: () =>
      apiFetch<Report>(
        `/api/channels/${message.channel_id}/messages/${message.id}/spillage`,
        json({ reason: reason.trim() }),
      ),
    onSuccess: () => {
      toast.success(t('spillage.reported'));
      onOpenChange(false);
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.problem.code === 'already_reported'
          ? t('spillage.alreadyReported')
          : t('spillage.failed'),
      ),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('spillage.reportTitle')}</DialogTitle>
          <DialogDescription>{t('spillage.reportHint')}</DialogDescription>
        </DialogHeader>
        <blockquote className="line-clamp-3 border-l-2 pl-3 text-sm text-muted-foreground">
          {plainText(message.body)}
        </blockquote>
        <div className="grid gap-1">
          <Label htmlFor={id}>{t('spillage.reason')}</Label>
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
          <Button disabled={send.isPending || reason.trim() === ''} onClick={() => send.mutate()}>
            <ShieldAlertIcon strokeWidth={1.75} />
            {t('spillage.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The reports of a workspace, for its spillage reviewers; owners choose the reviewers. */
export function SpillageDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<Report | null>(null);
  const reports = useQuery({
    queryKey: ['spillage', workspace.id],
    queryFn: () =>
      apiFetch<{ reports: Report[] }>(`/api/workspaces/${workspace.id}/spillage`).then(
        (r) => r.reports,
      ),
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ['spillage', workspace.id] });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'remove' | 'dismiss' }) =>
      apiFetch<Report>(`/api/spillage/${id}/decision`, json({ decision })),
    onSuccess: (r) => {
      void reload();
      toast.success(r.status === 'removed' ? t('spillage.removed') : t('spillage.dismissed'));
    },
    onError: () => toast.error(t('spillage.failed')),
  });
  const download = async (r: Report) => {
    try {
      const report = await apiFetch<unknown>(`/api/spillage/${r.id}/incident`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      );
      a.download = `cenacle-spillage-${r.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      toast.error(t('spillage.failed'));
    }
  };
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const open_ = (reports.data ?? []).filter((r) => r.status === 'open');
  const decided = (reports.data ?? []).filter((r) => r.status !== 'open');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('spillage.title')}</DialogTitle>
          <DialogDescription>{t('spillage.hint')}</DialogDescription>
        </DialogHeader>
        {reports.isPending ? (
          <Skeleton className="h-32" />
        ) : reports.isError ? (
          <p className="text-sm text-muted-foreground">{t('spillage.notReviewer')}</p>
        ) : (
          <div className="flex flex-col gap-5">
            <section aria-labelledby="spillage-open" className="flex flex-col gap-2">
              <h3 id="spillage-open" className="text-sm font-semibold">
                {t('spillage.open', { count: open_.length })}
              </h3>
              {open_.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('spillage.none')}</p>
              )}
              <ul className="flex flex-col gap-2" data-testid="spillage-open">
                {open_.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <p className="text-xs text-muted-foreground">
                      {t('spillage.where', {
                        channel: r.channel_name,
                        author: r.author_name ?? '',
                        time: when.format(new Date(r.created_at)),
                      })}
                    </p>
                    <blockquote className="line-clamp-4 border-l-2 border-destructive/60 pl-3">
                      {r.body ? plainText(r.body) : ''}
                    </blockquote>
                    <p>
                      <span className="font-medium">{r.reported_by}</span>: {r.reason}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="destructive" size="sm" onClick={() => setRemoving(r)}>
                        {t('spillage.remove')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ id: r.id, decision: 'dismiss' })}
                      >
                        {t('spillage.dismiss')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            {decided.length > 0 && (
              <section aria-labelledby="spillage-decided" className="flex flex-col gap-2">
                <h3 id="spillage-decided" className="text-sm font-semibold">
                  {t('spillage.decided')}
                </h3>
                <ul className="flex flex-col gap-1.5" data-testid="spillage-decided">
                  {decided.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span>
                        {t(`spillage.status.${r.status}`)} · #{r.channel_name || '—'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {r.decided_by} · {r.decided_at ? when.format(new Date(r.decided_at)) : ''}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void download(r)}
                      >
                        <DownloadIcon strokeWidth={1.75} />
                        {t('spillage.incident')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {workspace.role === 'owner' && <ReviewersSection workspace={workspace} />}
          </div>
        )}
        <ConfirmDialog
          open={!!removing}
          onOpenChange={(o) => !o && setRemoving(null)}
          severity="s2"
          irreversible
          title={t('spillage.removeTitle')}
          description={<p>{t('spillage.removeDescription')}</p>}
          confirmLabel={t('spillage.remove')}
          onConfirm={async () => {
            await decide.mutateAsync({ id: removing!.id, decision: 'remove' });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReviewersSection({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const members = useQuery(workspaceMembersQuery(workspace.id));
  const [chosen, setChosen] = useState<string[]>(workspace.spillage_reviewers ?? []);
  const save = useMutation({
    mutationFn: () =>
      apiFetch<void>(
        `/api/workspaces/${workspace.id}/spillage-reviewers`,
        json({ user_ids: chosen }, 'PUT'),
      ),
    onSuccess: () => {
      void reloadWorkspaces(queryClient);
      toast.success(t('spillage.reviewersSaved'));
    },
    onError: () => toast.error(t('spillage.failed')),
  });
  const people = (members.data ?? []).filter((m) => m.role !== 'guest');
  return (
    <section aria-labelledby="spillage-reviewers" className="flex flex-col gap-2 border-t pt-4">
      <h3 id="spillage-reviewers" className="text-sm font-semibold">
        {t('spillage.reviewers')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('spillage.reviewersHint')}</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {people.map((m) => (
          <label key={m.user.id} className="flex min-h-target items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              className="size-4"
              data-target-exempt
              checked={chosen.includes(m.user.id)}
              onChange={(e) =>
                setChosen((c) =>
                  e.target.checked ? [...c, m.user.id] : c.filter((x) => x !== m.user.id),
                )
              }
            />
            {m.user.display_name}
          </label>
        ))}
      </div>
      <div>
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {t('spillage.saveReviewers')}
        </Button>
      </div>
    </section>
  );
}
