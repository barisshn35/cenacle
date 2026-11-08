// SPDX-License-Identifier: AGPL-3.0-only
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useCustomEmoji } from '../richer/use-custom-emoji';
import type { CustomEmoji } from '../richer/richer';

/** ":" and at least two name characters up to the caret ("10:30" is not one). */
function emojiQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s):([a-z0-9_+-]{2,32})$/i.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() } : null;
}

/** The workspace's emoji for a query: names starting with it first. */
export function matchEmoji(all: Iterable<CustomEmoji>, query: string, limit = 8): CustomEmoji[] {
  const list = [...all];
  const starts = list.filter((e) => e.name.startsWith(query));
  const within = list.filter((e) => !e.name.startsWith(query) && e.name.includes(query));
  return [...starts, ...within].slice(0, limit);
}

/**
 * Suggests the workspace's emoji while typing ":name": arrow keys choose,
 * Enter or Tab inserts ":name: ", Escape closes.
 */
export function useEmojiSuggest({
  input,
  value,
  onChange,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const emoji = useCustomEmoji();
  const [state, setState] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const candidates = state ? matchEmoji(emoji.values(), state.query) : [];
  const open = candidates.length > 0;

  /** Call after every change of the text or caret. */
  const update = () => {
    const el = input.current;
    if (!el || emoji.size === 0) return;
    const next = emojiQuery(el.value, el.selectionStart ?? el.value.length);
    setState(next);
    if (next?.query !== state?.query) setActive(0);
  };

  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const pick = (e: CustomEmoji) => {
    if (!state) return;
    const end = input.current?.selectionStart ?? value.length;
    const inserted = `:${e.name}: `;
    caret.current = state.start + inserted.length;
    onChange(value.slice(0, state.start) + inserted + value.slice(end));
    setState(null);
  };

  /** Handles the list's keys; true when the key was used. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + step + candidates.length) % candidates.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(candidates[active]!);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setState(null);
      return true;
    }
    return false;
  };

  const current = candidates[active];
  const popup = open ? (
    <div className="absolute bottom-full start-0 z-20 mb-1 w-72 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <ul
        id={listId}
        role="listbox"
        aria-label={t('richer.emoji.suggest')}
        data-testid="emoji-suggest"
      >
        {candidates.map((c, i) => (
          <li
            key={c.id}
            role="option"
            aria-selected={i === active}
            // The text box keeps the focus; the pointer picks without taking it.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'flex min-h-target cursor-default items-center gap-2 rounded-md px-2 text-sm',
              i === active && 'bg-accent text-accent-foreground',
            )}
          >
            <img src={c.url} alt="" className="size-6 shrink-0 object-contain" />
            <span className="truncate">:{c.name}:</span>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status">
        {current &&
          t('mentions.active', {
            name: `:${current.name}:`,
            n: active + 1,
            count: candidates.length,
          })}
      </p>
    </div>
  ) : null;

  return { popup, onKeyDown, update, open, listId };
}
