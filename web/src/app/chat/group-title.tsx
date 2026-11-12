// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { peopleNames, reloadChannels, setConversationTitle, type Channel } from './data';

/** Up to this many characters (the server's limit). */
export const MAX_TITLE = 80;

/**
 * The name of a group conversation: everyone in it may give one or take it
 * away; without one the conversation is called after its people.
 */
export function GroupTitleField({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const id = useId();
  const saved = channel.title ?? '';
  const [title, setTitle] = useState(saved);
  const [shown, setShown] = useState(saved);
  if (shown !== saved) {
    // Someone else in the conversation named it.
    setShown(saved);
    setTitle(saved);
  }
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => setConversationTitle(channel.id, title.trim()),
    onSuccess: async (c) => {
      await reloadChannels(queryClient);
      toast.success(c.title ? t('dm.naming.saved') : t('dm.naming.removed'));
    },
    onError: () => toast.error(t('dm.naming.failed')),
  });
  const changed = title.trim() !== saved;
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) save.mutate();
      }}
    >
      <Label htmlFor={id}>{t('dm.naming.label')}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={title}
          maxLength={MAX_TITLE}
          placeholder={peopleNames(channel)}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!changed || save.isPending}
          className="self-center"
        >
          {t('chat.save')}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('dm.naming.hint')}
      </p>
    </form>
  );
}
