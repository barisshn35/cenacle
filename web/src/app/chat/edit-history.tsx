// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HistoryIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { useSession } from '../auth/session';
import { Body } from '../compliance/encrypted';
import { useActiveWorkspace } from './active-workspace';
import {
  messageEditsQuery,
  replaceMessage,
  restoreVersion,
  type Channel,
  type Message,
} from './data';
import { useFormatters } from './rows';

/**
 * "(edited)" under a message. Where its earlier versions can be seen (its
 * author, or everyone when the workspace shows them), it opens them.
 */
export function EditedLabel({ message, channel }: { message: Message; channel: Channel }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const self = useSession().user.id;
  const { workspace } = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  if (!message.edited_at) return null;
  const when = fmt.full.format(new Date(message.edited_at));
  const viewable = message.author.id === self || workspace?.edit_history === 'everyone';
  if (!viewable) {
    return (
      <span className="text-xs text-muted-foreground" title={when}>
        {t('chat.edited')}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        title={when}
        aria-label={t('edits.open', { when })}
        onClick={() => setOpen(true)}
        className="hit-target rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {t('chat.edited')}
      </button>
      {open && <EditHistoryDialog message={message} channel={channel} onOpenChange={setOpen} />}
    </>
  );
}

function EditHistoryDialog({
  message,
  channel,
  onOpenChange,
}: {
  message: Message;
  channel: Channel;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const edits = useQuery(messageEditsQuery(message));
  const canRestore = message.author.id === self && !channel.archived;
  const restore = useMutation({
    mutationFn: (body: string) => restoreVersion(message, body),
    onSuccess: (m) => {
      replaceMessage(queryClient, m);
      toast.success(t('edits.restored'));
      onOpenChange(false);
    },
    onError: () => toast.error(t('chat.editFailed')),
  });
  const time = (iso: string) => (
    <time dateTime={iso} className="font-mono tabular-nums">
      {fmt.full.format(new Date(iso))}
    </time>
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('edits.title')}</DialogTitle>
          <DialogDescription>
            {message.author.id === self ? t('edits.descriptionOwn') : t('edits.description')}
          </DialogDescription>
        </DialogHeader>
        <ol className="-mx-1 flex max-h-[60svh] flex-col gap-3 overflow-y-auto px-1">
          <li className="rounded-[10px] border bg-secondary px-4 py-3">
            <p className="mb-1.5 text-xs font-semibold">
              {t('edits.now')} · <span className="font-normal">{time(message.edited_at!)}</span>
            </p>
            <Body message={message} selfId={self} />
          </li>
          {edits.data?.map((e, i) => (
            <li key={`${e.replaced_at}-${i}`} className="rounded-[10px] border px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <HistoryIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
                <span>
                  {t('edits.written')} {time(e.written_at)}
                </span>
                {canRestore && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ms-auto"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(e.body)}
                  >
                    {t('edits.restore')}
                  </Button>
                )}
              </div>
              <Body message={{ ...message, body: e.body }} selfId={self} />
            </li>
          ))}
          {edits.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">{t('edits.none')}</li>
          )}
        </ol>
        {edits.isError && (
          <InlineError
            problem={edits.error instanceof ApiError ? edits.error.problem : { status: 500 }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
