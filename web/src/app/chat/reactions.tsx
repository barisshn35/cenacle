// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EmojiPicker } from 'frimousse';
import { SmileIcon, SmilePlusIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { addReaction, applyReaction, removeReaction, type Message } from './data';
import { CustomEmojiGrid, ReactionEmoji } from '../richer/emoji';

/** Adds or takes back the reader's reaction, showing it at once. */
function useToggleReaction(message: Message) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const self = useSession().user.id;
  return (emoji: string) => {
    const mine = message.reactions.some((r) => r.emoji === emoji && r.me);
    const ev = { channel_id: message.channel_id, message_id: message.id, emoji, user_id: self };
    applyReaction(queryClient, ev, !mine, self);
    (mine ? removeReaction(message, emoji) : addReaction(message, emoji)).catch(() => {
      applyReaction(queryClient, ev, mine, self); // undo the local change
      toast.error(t('reactions.failed'));
    });
  };
}

/** The emoji picker (data served by the app itself, not a CDN). */
export function EmojiPickerPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useTranslation();
  return (
    <EmojiPicker.Root
      emojibaseUrl="/emoji"
      locale="en"
      columns={8}
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      className="isolate flex h-80 w-72 flex-col"
    >
      <CustomEmojiGrid onPick={onPick} />
      <EmojiPicker.Search
        aria-label={t('reactions.search')}
        placeholder={t('reactions.search')}
        className="mb-2 min-h-target rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('reactions.loading')}
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('reactions.none')}
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="pb-1 select-none"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-popover px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1 px-1" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-accent"
                data-target-exempt
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}

/** "Add reaction": a button that opens the emoji picker. */
export function AddReactionButton({
  message,
  className,
}: {
  message: Message;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useToggleReaction(message);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('reactions.add')}
            data-action="react"
            className={className}
          />
        }
      >
        <SmilePlusIcon strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end">
        <PopoverTitle className="sr-only">{t('reactions.add')}</PopoverTitle>
        {open && (
          <EmojiPickerPanel
            onPick={(emoji) => {
              setOpen(false);
              if (!message.reactions.some((r) => r.emoji === emoji && r.me)) toggle(emoji);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The composer's emoji button: the workspace's emoji and the standard ones, put into the text. */
export function InsertEmojiButton({
  onPick,
  returnTo,
}: {
  onPick: (emoji: string) => void;
  /** Where the focus goes back to (the text box). */
  returnTo: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button type="button" size="icon" variant="ghost" aria-label={t('richer.emoji.insert')} />
        }
      >
        <SmileIcon strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" finalFocus={returnTo}>
        <PopoverTitle className="sr-only">{t('richer.emoji.insert')}</PopoverTitle>
        {open && (
          <EmojiPickerPanel
            onPick={(emoji) => {
              setOpen(false);
              onPick(emoji);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Reactions under a message: each toggles the reader's own. */
/** The reactions of a message; without canReact, only your own can be taken back. */
export function ReactionBar({
  message,
  canReact = true,
}: {
  message: Message;
  canReact?: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useToggleReaction(message);
  if (message.reactions.length === 0) return null;
  return (
    <ul aria-label={t('reactions.label')} className="mt-1 flex flex-wrap gap-1">
      {message.reactions.map((r) => (
        <li key={r.emoji}>
          <button
            type="button"
            aria-pressed={r.me}
            disabled={!canReact && !r.me}
            aria-label={t(r.me ? 'reactions.chipMine' : 'reactions.chip', {
              emoji: r.emoji,
              count: r.count,
            })}
            onClick={() => toggle(r.emoji)}
            className={cn(
              'inline-flex min-h-target min-w-target items-center gap-1 rounded-full border px-2 text-sm tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              r.me
                ? 'border-accent-brand/50 bg-accent text-accent-foreground'
                : 'border-border bg-background hover:bg-muted disabled:hover:bg-background',
            )}
          >
            <span aria-hidden className="inline-flex">
              <ReactionEmoji emoji={r.emoji} />
            </span>
            <span aria-hidden>{r.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
