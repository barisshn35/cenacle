// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import {
  addMessage,
  deleteMessage,
  editMessage,
  removeMessage,
  replaceMessage,
  restoreMessage,
  type Channel,
  type Message,
} from './data';
import { mentionsToText } from './markdown/mentions';
import { useMentionPicker } from './mention-picker';
import { useEditing, useMessagePermissions } from './message-state';

/**
 * Actions of a message. The button shows on hover and keyboard focus, and
 * always on touch screens (no hover there).
 */
export function MessageActions({ message, channel }: { message: Message; channel: Channel }) {
  const { t } = useTranslation();
  const can = useMessagePermissions(message, channel);
  const startEdit = useEditing((s) => s.set);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => deleteMessage(message),
    onMutate: () => removeMessage(queryClient, message),
    onSuccess: () =>
      showUndoToast({
        message: t('chat.deleted'),
        onUndo: async () => {
          const restored = await restoreMessage(message);
          addMessage(queryClient, restored);
        },
      }),
    onError: () => {
      addMessage(queryClient, message);
      toast.error(t('chat.deleteFailed'));
    },
  });

  if (!can.edit && !can.remove) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.actions')}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100"
          />
        }
      >
        <MoreHorizontalIcon strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {can.edit && (
          <DropdownMenuItem onClick={() => startEdit(message.id)}>
            <PencilIcon strokeWidth={1.75} />
            {t('chat.edit')}
          </DropdownMenuItem>
        )}
        {can.remove && (
          <DropdownMenuItem variant="destructive" onClick={() => remove.mutate()}>
            <Trash2Icon strokeWidth={1.75} />
            {t('glossary.delete')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Editing a message in place: Enter saves, Shift+Enter adds a line, Escape cancels. */
export function MessageEditor({ message }: { message: Message }) {
  const { t } = useTranslation();
  // Mentions are edited as @Name and become <@id> again when saved.
  const original = mentionsToText(message.body, message.mentions);
  const [body, setBody] = useState(original);
  const stop = useEditing((s) => s.set);
  const queryClient = useQueryClient();
  const input = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentionPicker({
    channelId: message.channel_id,
    input,
    value: body,
    onChange: setBody,
    initial: message.mentions,
  });

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [body]);

  const save = useMutation({
    mutationFn: (text: string) => editMessage(message, text),
    onSuccess: (edited) => {
      replaceMessage(queryClient, edited);
      stop(null);
    },
    onError: () => toast.error(t('chat.editFailed')),
  });

  const submit = () => {
    const text = body.trim();
    if (text === '' || text === original) {
      stop(null);
      return;
    }
    save.mutate(mentions.resolve(text).text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      stop(null);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative grid gap-1.5 py-1">
      {mentions.popup}
      <label htmlFor={`edit-${message.id}`} className="sr-only">
        {t('chat.editLabel')}
      </label>
      <textarea
        id={`edit-${message.id}`}
        ref={input}
        rows={1}
        value={body}
        maxLength={4000}
        onChange={(e) => {
          setBody(e.target.value);
          mentions.update();
        }}
        onSelect={mentions.update}
        onKeyDown={onKeyDown}
        aria-autocomplete="list"
        aria-controls={mentions.open ? mentions.listId : undefined}
        className="block w-full resize-none overflow-hidden rounded-lg border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-[0.9375rem]"
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button size="sm" onClick={submit} disabled={save.isPending}>
          {t('chat.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => stop(null)}>
          {t('glossary.cancel')}
        </Button>
        <span>{t('chat.editHint')}</span>
      </div>
    </div>
  );
}
