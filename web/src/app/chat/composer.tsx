// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClockIcon, PaperclipIcon, SendHorizontalIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { DraftStore } from '@cenacle/core/drafts';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { useActiveWorkspace } from './active-workspace';
import { CommandNotes } from './command-notes';
import { useCommandNotes } from './command-notes-state';
import { useCommandPicker } from './command-picker';
import { parseCommand, runCommand } from './commands';
import { useConnection } from './connection';
import { addMessage, sendTyping } from './data';
import { useMentionPicker } from './mention-picker';
import { useSession } from '../auth/session';
import { SendLaterDialog } from './send-later';
import { UploadList } from './uploads';
import { useUploads } from './use-uploads';
import { useSendMessage } from './send';
import { TypingIndicator } from './typing-indicator';

const MAX_LENGTH = 4000;
/** The text area grows up to this height (px), then scrolls. */
const MAX_HEIGHT = 240;
/** Typing notices go out at most this often (ms) while typing. */
const TYPING_EVERY = 3_000;
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
  const lastTyping = useRef(0);
  const change = (value: string) => {
    latest.current = value;
    setBody(value);
  };
  const typed = (value: string) => {
    change(value);
    const now = Date.now();
    if (value.trim() !== '' && now - lastTyping.current >= TYPING_EVERY) {
      lastTyping.current = now;
      void sendTyping(channelId).catch(() => undefined);
    }
  };
  const { send } = useSendMessage();
  const queryClient = useQueryClient();
  const key = { workspaceId: WORKSPACE, channelId };
  const mentions = useMentionPicker({ channelId, input, value: body, onChange: change });
  const workspaceId = useActiveWorkspace().id;
  const commands = useCommandPicker({ workspaceId, input, onChange: change });
  const addNote = useCommandNotes((s) => s.add);
  const [later, setLater] = useState(false);
  const { permissions } = useSession();
  const uploads = useUploads(channelId, permissions.max_file_size);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (files: FileList | File[]) => {
    if (!permissions.upload_files || files.length === 0) return;
    if (uploads.add(files)) toast(t('files.tooMany'));
  };

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

  // Grow with the text up to a limit; scroll only beyond it.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    const height = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [body]);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_LENGTH;
  const canSend =
    (trimmed !== '' || uploads.ready.length > 0) && !tooLong && !uploads.busy && !uploads.failed;

  const clear = () => {
    mentions.reset();
    change('');
    lastTyping.current = 0;
    void drafts.delete(key).catch(() => undefined);
  };

  /** Runs a slash command; its answer shows above the composer or in the channel. */
  const run = (command: string, text: string) => {
    clear();
    commands.close();
    void runCommand(channelId, command, text)
      .then((r) => {
        if (r.message) addMessage(queryClient, r.message);
        if (r.response_type === 'ephemeral' && (r.text || r.attachments?.length)) {
          addNote({ channelId, command, text: r.text ?? '', attachments: r.attachments ?? [] });
        }
      })
      .catch((err: unknown) => {
        const problem = err instanceof ApiError ? err.problem : undefined;
        addNote({
          channelId,
          command,
          text:
            problem?.code === 'unknown_command'
              ? t('commands.unknown', { command: `/${command}` })
              : (problem?.detail ?? t('commands.failed')),
          attachments: [],
          error: true,
        });
        // Give the text back so nothing typed is lost.
        if (problem?.code !== 'unknown_command') change(`/${command} ${text}`.trimEnd());
      });
  };

  const submit = () => {
    if (!canSend) return;
    // "//text" sends "/text" as a message.
    const command = trimmed.startsWith('//') ? null : parseCommand(trimmed);
    if (command && uploads.items.length === 0) {
      run(command.command, mentions.resolve(command.text).text);
      return;
    }
    const { text, people } = mentions.resolve(
      trimmed.startsWith('//') ? trimmed.slice(1) : trimmed,
    );
    send(channelId, text, people, uploads.ready);
    uploads.clear();
    clear();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commands.onKeyDown(e)) return;
    if (mentions.onKeyDown(e)) return;
    // Not while an input method (e.g. for CJK) is composing text.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const label = t('shell.composerPlaceholder', { channel: channelName });
  return (
    <footer className="shrink-0 px-4 pb-4">
      <CommandNotes channelId={channelId} />
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="composer" className="sr-only">
          {label}
        </label>
        {/* The frame holds the text and the send button side by side, so a
            scrollbar of long text never runs under the button. */}
        <div
          className="relative rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-4 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-aria-invalid:border-destructive"
          onDragOver={(e) => {
            if (permissions.upload_files && e.dataTransfer.types.includes('Files'))
              e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
        >
          {mentions.popup}
          {commands.popup}
          <UploadList uploads={uploads} />
          <div className="flex items-end gap-2">
            <textarea
              id="composer"
              ref={input}
              rows={1}
              value={body}
              onChange={(e) => {
                typed(e.target.value);
                mentions.update();
                commands.update();
              }}
              onSelect={() => {
                mentions.update();
                commands.update();
              }}
              aria-autocomplete="list"
              aria-controls={
                commands.open ? commands.listId : mentions.open ? mentions.listId : undefined
              }
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }}
              aria-describedby={
                body.length > MAX_LENGTH - 200 ? 'composer-hint composer-count' : 'composer-hint'
              }
              aria-invalid={tooLong || undefined}
              placeholder={label}
              className="block min-h-target flex-1 resize-none overflow-hidden bg-transparent py-1.5 text-base outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
            />
            {permissions.upload_files && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('files.attach')}
                  onClick={() => picker.current?.click()}
                >
                  <PaperclipIcon strokeWidth={1.75} />
                </Button>
              </>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('scheduled.open')}
              onClick={() => setLater(true)}
            >
              <ClockIcon strokeWidth={1.75} />
            </Button>
            <Button type="submit" size="icon" aria-label={t('chat.send')} disabled={!canSend}>
              <SendHorizontalIcon strokeWidth={1.75} />
            </Button>
          </div>
        </div>
        <div className="mt-1.5 flex justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div id="composer-hint">
              <ConnectionNotice />
            </div>
            <TypingIndicator channelId={channelId} />
          </div>
          {body.length > MAX_LENGTH - 200 && (
            <p
              id="composer-count"
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
      <SendLaterDialog
        open={later}
        onOpenChange={(open) => {
          setLater(open);
          if (!open) requestAnimationFrame(() => input.current?.focus());
        }}
        channelId={channelId}
        body={() =>
          canSend &&
          uploads.items.length === 0 &&
          !(parseCommand(trimmed) && !trimmed.startsWith('//'))
            ? mentions.resolve(trimmed.startsWith('//') ? trimmed.slice(1) : trimmed).text
            : ''
        }
        onScheduled={clear}
      />
    </footer>
  );
}
