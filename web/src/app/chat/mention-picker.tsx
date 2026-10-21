// SPDX-License-Identifier: Apache-2.0
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { initials } from '../auth/sign-out';
import { membersQuery } from './data';
import { textToMentions } from './markdown/mentions';

export type Mentioned = { id: string; display_name: string };

/** "@" and what follows it up to the caret, when the caret is in a mention. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

const fold = (s: string) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '');

/**
 * Suggests channel members while typing "@name": arrow keys choose, Enter or
 * Tab inserts "@Name", Escape closes. The people picked are remembered, so
 * the text can become <@id> mentions when it is sent.
 */
export function useMentionPicker({
  channelId,
  input,
  value,
  onChange,
  initial = [],
}: {
  channelId: string;
  input: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  initial?: Mentioned[];
}) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  const listId = useId();
  const [state, setState] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const picked = useRef<Mentioned[]>(initial);
  const members = useQuery({ ...membersQuery(channelId), enabled: state !== null });

  const candidates = state
    ? (members.data ?? [])
        .map((m) => m.user)
        .filter((u) => u.id !== self)
        .filter((u) => {
          const q = fold(state.query);
          return fold(u.display_name).includes(q) || fold(u.email).startsWith(q);
        })
        .slice(0, 8)
    : [];
  const open = state !== null && candidates.length > 0;

  /** Call after every change of the text or caret. */
  const update = () => {
    const el = input.current;
    if (!el) return;
    const next = mentionQuery(el.value, el.selectionStart ?? el.value.length);
    setState(next);
    if (next?.query !== state?.query) setActive(0);
  };

  // The caret goes after the inserted name right after it renders, before
  // the next key press.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const pick = (person: Mentioned) => {
    if (!state) return;
    const end = input.current?.selectionStart ?? value.length;
    const inserted = `@${person.display_name} `;
    const next = value.slice(0, state.start) + inserted + value.slice(end);
    if (!picked.current.some((p) => p.id === person.id)) picked.current.push(person);
    caret.current = state.start + inserted.length;
    onChange(next);
    setState(null);
  };

  /** Handles the picker's keys; true when the key was used. */
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
    <div className="absolute bottom-full left-0 z-20 mb-1 w-72 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <ul id={listId} role="listbox" aria-label={t('mentions.label')}>
        {candidates.map((u, i) => (
          <li
            key={u.id}
            role="option"
            aria-selected={i === active}
            // The text box keeps the focus; the pointer picks without taking it.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(u);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'flex min-h-target cursor-default items-center gap-2 rounded-md px-2 text-sm',
              i === active && 'bg-accent text-accent-foreground',
            )}
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold"
            >
              {initials(u.display_name || u.email)}
            </span>
            <span className="truncate">{u.display_name}</span>
            <span className="truncate text-xs text-muted-foreground">{u.email}</span>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status">
        {current &&
          t('mentions.active', {
            name: current.display_name,
            n: active + 1,
            count: candidates.length,
          })}
      </p>
    </div>
  ) : null;

  /** The text with the picked people as <@id> mentions, and those people. */
  const resolve = (text: string) => {
    const people = picked.current.filter((p) => text.includes(`@${p.display_name}`));
    return { text: textToMentions(text, people), people };
  };
  /** Forget the people picked (after sending). */
  const reset = () => {
    picked.current = [];
  };

  return { popup, onKeyDown, update, resolve, reset, open, listId };
}
