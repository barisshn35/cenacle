// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SendHorizontalIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DraftStore } from '@cenacle/core/drafts';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { useConnection } from './connection';
import { useSendMessage } from './send';

const MAX_LENGTH = 4000;
/** Workspaces arrive in v0.6; until then drafts belong to one implicit workspace. */
const WORKSPACE = 'default';

const drafts = new DraftStore();

function ConnectionNotice() {
  const { t } = useTranslation();
  const status = useConnection((s) => s.status);
  const text =
    status === 'offline'
      ? t('chat.offline')
      : status === 'reconnecting'
        ? t('chat.reconnecting')
        : undefined;
  // The live region exists before its text changes, so screen readers announce it.
  return (
    <p role="status" className={cn('px-1 text-xs text-muted-foreground', !text && 'sr-only')}>
      {text}
    </p>
  );
}

/**
 * Message input. Enter sends, Shift+Enter adds a line. The text is kept as a
 * draft per channel in IndexedDB until it is sent.
 */
export function Composer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  // The draft has been read; until then typing must not be overwritten by it,
  // and nothing is saved.
  const loaded = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // The latest text, for saving the draft when the composer goes away.
  const latest = useRef('');
  const change = (value: string) => {
    latest.current = value;
    setBody(value);
  };
  const { send } = useSendMessage();
  const key = { workspaceId: WORKSPACE, channelId };

  // Load the channel's draft (the composer is keyed by channel).
  useEffect(() => {
    let cancelled = false;
    const k = { workspaceId: WORKSPACE, channelId };
    void drafts
      .get(k)
      .catch(() => undefined)
      .then((d) => {
        if (cancelled) return;
        loaded.current = true;
        if (latest.current === '' && d) {
          latest.current = d.body;
          setBody(d.body);
        } else if (latest.current !== '') {
          // Typed before the draft arrived: what was typed wins.
          void drafts.save(k, latest.current).catch(() => undefined);
        }
      });
    return () => {
      cancelled = true;
      if (loaded.current) void drafts.save(k, latest.current).catch(() => undefined);
    };
  }, [channelId]);

  // Save drafts shortly after typing stops.
  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => {
      void drafts.save({ workspaceId: WORKSPACE, channelId }, body).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [body, channelId]);

  // Grow with the text up to a limit.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [body]);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LENGTH;
  const canSend = trimmed !== '' && !tooLong;

  const submit = () => {
    if (!canSend) return;
    send(channelId, trimmed);
    change('');
    void drafts.delete(key).catch(() => undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Not while an input method (e.g. for CJK) is composing text.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const label = t('shell.composerPlaceholder', { channel: channelName });
  return (
    <footer className="shrink-0 px-4 pb-4">
      <form
        className="relative mx-auto max-w-3xl"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer" className="sr-only">
          {label}
        </label>
        <textarea
          id="composer"
          ref={input}
          rows={1}
          value={body}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="composer-hint"
          aria-invalid={tooLong || undefined}
          placeholder={label}
          className="block min-h-11 w-full resize-none rounded-xl border border-input bg-card py-3 pr-14 pl-4 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-[15px]"
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t('chat.send')}
          disabled={!canSend}
          className="absolute right-2 bottom-1.5"
        >
          <SendHorizontalIcon strokeWidth={1.75} />
        </Button>
        <div id="composer-hint" className="mt-1.5 flex justify-between gap-2">
          <ConnectionNotice />
          {body.length > MAX_LENGTH - 200 && (
            <p
              className={cn(
                'px-1 text-xs tabular-nums',
                tooLong ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {t('chat.charactersLeft', { count: MAX_LENGTH - body.length })}
            </p>
          )}
        </div>
      </form>
    </footer>
  );
}
