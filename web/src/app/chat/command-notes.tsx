// SPDX-License-Identifier: AGPL-3.0-only
import { XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { useSession } from '../auth/session';
import { Attachments } from './attachments';
import { useCommandNotes } from './command-notes-state';
import { MessageBody } from './markdown/message-body';

/** Command answers for the channel, above the composer. */
export function CommandNotes({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const all = useCommandNotes((s) => s.notes);
  const notes = all.filter((n) => n.channelId === channelId);
  const dismiss = useCommandNotes((s) => s.dismiss);
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto flex max-w-3xl flex-col gap-1.5 empty:hidden"
    >
      {notes.map((n) => (
        <div
          key={n.id}
          data-testid="command-note"
          className={
            'flex items-start gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1 pl-3 text-sm ' +
            (n.error ? 'border-destructive/50' : 'border-border')
          }
        >
          <div className="min-w-0 flex-1 py-0.5">
            <p className="text-xs text-muted-foreground">
              {t('commands.onlyYou', { command: `/${n.command}` })}
            </p>
            {n.text && <MessageBody body={n.text} mentions={[]} selfId={self} />}
            {n.attachments.length > 0 && <Attachments items={n.attachments} selfId={self} />}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('commands.dismiss')}
            onClick={() => dismiss(n.id)}
          >
            <XIcon strokeWidth={1.75} />
          </Button>
        </div>
      ))}
    </div>
  );
}
