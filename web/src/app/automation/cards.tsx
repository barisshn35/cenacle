// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ClipboardListIcon, FileTextIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { MessageBody } from '../chat/markdown/message-body';
import { workspaceMembersQuery } from '../chat/workspaces';
import { decideTask, submitTask, taskQuery, type Submission, type Task } from './automation';
import { FormFillDialog } from './form-fill';

/** The answers of a filled-in form, posted in a channel. */
export function SubmissionCard({ submission }: { submission: Submission }) {
  const { t } = useTranslation();
  return (
    <figure
      data-testid="submission"
      className="mt-1 max-w-lg rounded-[10px] border border-rule-strong bg-background px-4 py-3 text-sm"
    >
      <figcaption className="flex items-center gap-2 font-medium">
        <FileTextIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.75} />
        {submission.form_name}
      </figcaption>
      <dl className="mt-2 grid gap-2">
        {submission.answers.map((a) => (
          <div key={a.id}>
            <dt className="text-xs text-muted-foreground">{a.label}</dt>
            <dd className="whitespace-pre-line">{a.value || t('automation.card.empty')}</dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}

/** <@id> mentions of a task's title, with the workspace's people. */
function usePeople() {
  const ws = useActiveWorkspace().id;
  const members = useQuery({ ...workspaceMembersQuery(ws ?? ''), enabled: !!ws }).data;
  return useMemo(
    () => (members ?? []).map((m) => ({ id: m.user.id, display_name: m.user.display_name })),
    [members],
  );
}

/** A workflow's form to fill in or approval to give, in a conversation with the Cenacle bot. */
export function TaskCard({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const people = usePeople();
  const queryClient = useQueryClient();
  const commentId = useId();
  const [comment, setComment] = useState('');
  const [filling, setFilling] = useState(false);
  const mine = task.assignees.includes(self) && task.status === 'open';
  const full = useQuery({ ...taskQuery(task.id), enabled: filling });
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideTask(task.id, approve, comment.trim()),
    onSuccess: () => {
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('automation.card.failed')),
  });
  const approval = task.kind === 'approval';
  const status =
    task.status === 'approved'
      ? t('automation.card.approvedBy', { name: task.done_by?.display_name ?? '' })
      : task.status === 'rejected'
        ? t('automation.card.rejectedBy', { name: task.done_by?.display_name ?? '' })
        : task.status === 'done'
          ? t('automation.card.filledBy', { name: task.done_by?.display_name ?? '' })
          : task.status === 'cancelled'
            ? t('automation.card.cancelled')
            : approval
              ? t('automation.card.waitingApproval')
              : t('automation.card.waitingForm');
  return (
    <div
      data-testid="task"
      data-status={task.status}
      className={cn(
        'mt-1 max-w-lg rounded-[10px] border border-rule-strong px-4 py-3.5 text-sm',
        task.status === 'open' ? 'bg-background' : 'bg-muted/40',
        className,
      )}
    >
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ClipboardListIcon aria-hidden className="size-4" strokeWidth={1.75} />
        {approval ? t('automation.card.approval') : t('automation.card.form')}
      </p>
      <div className="mt-1 font-medium">
        <MessageBody body={task.title} mentions={people} selfId={self} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        {task.status === 'approved' && <CheckIcon aria-hidden className="size-3.5" />}
        {task.status === 'rejected' && <XIcon aria-hidden className="size-3.5" />}
        {status}
      </p>
      {task.comment && <p className="mt-1 text-sm italic">“{task.comment}”</p>}
      {mine && approval && (
        <div className="mt-3 flex flex-col gap-2">
          <label htmlFor={commentId} className="sr-only">
            {t('automation.card.comment')}
          </label>
          <Input
            id={commentId}
            value={comment}
            maxLength={1000}
            placeholder={t('automation.card.comment')}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              <CheckIcon strokeWidth={1.75} />
              {t('automation.card.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              <XIcon strokeWidth={1.75} />
              {t('automation.card.reject')}
            </Button>
          </div>
        </div>
      )}
      {mine && !approval && (
        <Button size="sm" className="mt-3" onClick={() => setFilling(true)}>
          {t('automation.card.fill')}
        </Button>
      )}
      {filling && full.data?.form && (
        <FormFillDialog
          form={full.data.form}
          open
          onOpenChange={setFilling}
          onSubmit={(values) =>
            submitTask(task.id, values).then(() =>
              queryClient.invalidateQueries({ queryKey: ['tasks'] }),
            )
          }
        />
      )}
    </div>
  );
}
