// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BotIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { assistantDraftsChanged, assistantDraftsQuery, dropAssistantDraft } from './assistants';

/**
 * Above the message box: a draft the person's assistant left here (ADR 0056).
 * Nothing is sent: the person puts it in the box to edit and send, or throws
 * it away.
 */
export function AssistantDraftBar({
  channelId,
  rootId,
  onUse,
}: {
  channelId: string;
  rootId?: string;
  onUse: (text: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const draft = useQuery(assistantDraftsQuery).data?.find(
    (d) => d.channel_id === channelId && (d.root_id ?? undefined) === rootId,
  );
  if (!draft) return null;
  const drop = (use: boolean) => {
    if (use) onUse(draft.body);
    void dropAssistantDraft(channelId)
      .then(() => assistantDraftsChanged(queryClient))
      .catch(() => toast.error(t('assistants.failed')));
  };
  return (
    <div
      role="region"
      aria-label={t('assistants.draft.label', { name: draft.assistant })}
      className="mb-2 flex flex-wrap items-start gap-3 rounded-[10px] border border-dashed border-accent-brand/60 bg-accent-brand/5 px-3 py-2 text-sm"
      data-testid="assistant-draft"
    >
      <BotIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-accent-brand"
        strokeWidth={1.75}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-muted-foreground">
          {t('assistants.draft.from', { name: draft.assistant })}
        </p>
        <p className="line-clamp-3 break-words whitespace-pre-wrap">{draft.body}</p>
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => drop(true)}>
          {t('assistants.draft.use')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => drop(false)}>
          {t('assistants.draft.drop')}
        </Button>
      </div>
    </div>
  );
}
