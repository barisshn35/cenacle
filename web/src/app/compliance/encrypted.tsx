// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LockIcon, LockOpenIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { MessageBody } from '../chat/markdown/message-body';
import type { Channel, Message } from '../chat/data';
import { decrypt, isEnvelope, unlock, useChannelKeys } from './e2e';

/** A message body, opened with the channel's key when it is an envelope. */
export function Body({ message, selfId }: { message: Message; selfId: string }) {
  const { t } = useTranslation();
  const key = useChannelKeys((s) => s.keys[message.channel_id]);
  const envelope = isEnvelope(message.body);
  const text = useQuery({
    queryKey: ['plain', message.id, message.body, !!key],
    queryFn: () => (key ? decrypt(key, message.body) : null),
    enabled: envelope,
    staleTime: Infinity,
  });
  if (!envelope) {
    return (
      <MessageBody
        body={message.body}
        mentions={message.mentions}
        selfId={selfId}
        broadcast={message.broadcast}
      />
    );
  }
  if (text.data) {
    return <MessageBody body={text.data} mentions={message.mentions} selfId={selfId} />;
  }
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
      <LockIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {text.isPending && key ? t('e2e.opening') : t('e2e.locked')}
    </p>
  );
}

/** Asks for the passphrase of an encrypted channel and keeps its key on this device. */
export function UnlockPanel({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const id = useId();
  const setKey = useChannelKeys((s) => s.set);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  return (
    <footer className="shrink-0 px-4 pb-4">
      <form
        data-testid="unlock"
        className="mx-auto flex max-w-3xl flex-col gap-2 rounded-xl border px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setWrong(false);
          void unlock(passphrase, channel.key_check ?? '')
            .then((key) => {
              if (key) setKey(channel.id, key);
              else setWrong(true);
            })
            .finally(() => setBusy(false));
        }}
      >
        <Label htmlFor={`${id}-pass`} className="flex items-center gap-1.5">
          <LockIcon aria-hidden className="size-4" strokeWidth={1.75} />
          {t('e2e.unlockLabel')}
        </Label>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {t('e2e.unlockHint')}
        </p>
        <div className="flex gap-2">
          <Input
            id={`${id}-pass`}
            type="password"
            autoComplete="off"
            value={passphrase}
            aria-describedby={`${id}-hint`}
            aria-invalid={wrong || undefined}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <Button type="submit" disabled={busy || !passphrase} aria-busy={busy}>
            <LockOpenIcon strokeWidth={1.75} />
            {t('e2e.unlock')}
          </Button>
        </div>
        {wrong && <InlineError title={t('e2e.wrong')} />}
      </form>
    </footer>
  );
}

/** In a channel's details: that it is encrypted, and forgetting its key here. */
export function EncryptionInfo({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const key = useChannelKeys((s) => s.keys[channel.id]);
  const setKey = useChannelKeys((s) => s.set);
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 text-sm" data-testid="encryption-info">
      <p className="flex items-center gap-1.5 font-medium">
        <LockIcon aria-hidden className="size-4" strokeWidth={1.75} />
        {t('e2e.info')}
      </p>
      <p className="text-muted-foreground">{t('e2e.infoHint')}</p>
      {key && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setKey(channel.id, null)}>
            {t('e2e.forget')}
          </Button>
        </div>
      )}
    </div>
  );
}
