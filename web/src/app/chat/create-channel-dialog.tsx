// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
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
import { useActiveWorkspace } from './active-workspace';
import { createChannel, reloadChannels } from './data';

/** Creating a channel (administrator only). */
export function CreateChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = {
    name: useId(),
    topic: useId(),
    everyone: useId(),
    error: useId(),
    visibility: useId(),
  };
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const { id: workspaceId } = useActiveWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: createChannel,
    onSuccess: (channel) => {
      void reloadChannels(queryClient);
      onOpenChange(false);
      setName('');
      setTopic('');
      setEveryone(false);
      setVisibility('public');
      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
    },
  });
  const taken =
    create.error instanceof ApiError && create.error.problem.code === 'channel_name_taken';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') return;
    if (!workspaceId) return;
    create.mutate({
      workspace_id: workspaceId,
      name: name.trim(),
      topic: topic.trim(),
      kind: 'standard',
      visibility,
      is_default: visibility === 'public' && everyone,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('channels.createTitle')}</DialogTitle>
            <DialogDescription>{t('channels.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={ids.name}>{t('channels.name')}</Label>
            <Input
              id={ids.name}
              value={name}
              maxLength={80}
              required
              autoComplete="off"
              aria-invalid={taken || undefined}
              aria-describedby={create.isError ? ids.error : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={ids.topic}>{t('channels.topicOptional')}</Label>
            <Input
              id={ids.topic}
              value={topic}
              maxLength={250}
              autoComplete="off"
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t('channels.visibility.label')}</legend>
            {(['public', 'private'] as const).map((v) => (
              <div key={v} className="flex items-start gap-2">
                <input
                  id={`${ids.visibility}-${v}`}
                  type="radio"
                  name={ids.visibility}
                  value={v}
                  checked={visibility === v}
                  onChange={() => setVisibility(v)}
                  aria-describedby={`${ids.visibility}-${v}-hint`}
                  className="size-6 shrink-0 accent-primary"
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={`${ids.visibility}-${v}`}>{t(`channels.visibility.${v}`)}</Label>
                  <p id={`${ids.visibility}-${v}-hint`} className="text-xs text-muted-foreground">
                    {t(`channels.visibility.${v}Hint`)}
                  </p>
                </div>
              </div>
            ))}
          </fieldset>
          <div className="flex items-start gap-2">
            <input
              id={ids.everyone}
              type="checkbox"
              checked={visibility === 'public' && everyone}
              disabled={visibility === 'private'}
              onChange={(e) => setEveryone(e.target.checked)}
              className="size-6 shrink-0 accent-primary"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids.everyone}>{t('channels.everyone')}</Label>
              <p className="text-xs text-muted-foreground">{t('channels.everyoneHint')}</p>
            </div>
          </div>
          {create.isError && (
            <InlineError
              id={ids.error}
              title={taken ? t('channels.nameTaken') : undefined}
              problem={create.error instanceof ApiError ? create.error.problem : { status: 0 }}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('glossary.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending || name.trim() === ''}>
              {t('channels.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
