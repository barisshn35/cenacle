// SPDX-License-Identifier: AGPL-3.0-only
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
import { newKeyCheck, useChannelKeys } from '../compliance/e2e';
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
    secret: useId(),
  };
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [forum, setForum] = useState(false);
  const [encrypted, setEncrypted] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const setKey = useChannelKeys((s) => s.set);
  const mismatch = encrypted && again !== '' && passphrase !== again;
  const { id: workspaceId } = useActiveWorkspace();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    mutationFn: async (input: Omit<Parameters<typeof createChannel>[0], 'key_check'>) => {
      if (!input.encrypted) return createChannel(input);
      // The key stays here; the server gets its salt and a check only.
      const { key, check } = await newKeyCheck(passphrase);
      const channel = await createChannel({ ...input, key_check: check });
      setKey(channel.id, key);
      return channel;
    },
    onSuccess: (channel) => {
      void reloadChannels(queryClient);
      onOpenChange(false);
      setName('');
      setTopic('');
      setEveryone(false);
      setVisibility('public');
      setForum(false);
      setEncrypted(false);
      setPassphrase('');
      setAgain('');
      void navigate({ to: '/c/$channelId', params: { channelId: channel.id } });
    },
  });
  const taken =
    create.error instanceof ApiError && create.error.problem.code === 'channel_name_taken';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') return;
    if (!workspaceId) return;
    if (encrypted && (passphrase.length < 12 || passphrase !== again)) return;
    create.mutate({
      workspace_id: workspaceId,
      name: name.trim(),
      topic: topic.trim(),
      kind: forum && !encrypted ? 'forum' : 'standard',
      visibility,
      is_default: visibility === 'public' && everyone,
      encrypted,
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
              id={`${ids.everyone}-forum`}
              type="checkbox"
              checked={forum && !encrypted}
              disabled={encrypted}
              onChange={(e) => setForum(e.target.checked)}
              className="size-6 shrink-0 accent-primary"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={`${ids.everyone}-forum`}>{t('community.forum.kind')}</Label>
              <p className="text-xs text-muted-foreground">{t('community.forum.kindHint')}</p>
            </div>
          </div>
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
          <div className="flex items-start gap-2">
            <input
              id={ids.secret}
              type="checkbox"
              checked={encrypted}
              onChange={(e) => setEncrypted(e.target.checked)}
              aria-describedby={`${ids.secret}-hint`}
              className="size-6 shrink-0 accent-primary"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids.secret}>{t('e2e.create')}</Label>
              <p id={`${ids.secret}-hint`} className="text-xs text-muted-foreground">
                {t('e2e.createHint')}
              </p>
            </div>
          </div>
          {encrypted && (
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-2">
                <Label htmlFor={`${ids.secret}-pass`}>{t('e2e.passphrase')}</Label>
                <Input
                  id={`${ids.secret}-pass`}
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={passphrase}
                  aria-describedby={`${ids.secret}-pass-hint`}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                <p id={`${ids.secret}-pass-hint`} className="text-xs text-muted-foreground">
                  {t('e2e.passphraseHint')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${ids.secret}-again`}>{t('e2e.again')}</Label>
                <Input
                  id={`${ids.secret}-again`}
                  type="password"
                  autoComplete="new-password"
                  required
                  value={again}
                  aria-invalid={mismatch || undefined}
                  onChange={(e) => setAgain(e.target.value)}
                />
                {mismatch && <InlineError title={t('e2e.mismatch')} politeness="status" />}
              </div>
            </div>
          )}
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
            <Button
              type="submit"
              disabled={
                create.isPending ||
                name.trim() === '' ||
                (encrypted && (passphrase.length < 12 || passphrase !== again))
              }
            >
              {t('channels.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
