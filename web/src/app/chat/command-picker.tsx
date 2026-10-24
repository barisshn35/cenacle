// SPDX-License-Identifier: AGPL-3.0-only
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
import { commandsQuery } from './commands';

/** The command being typed: "/" and a name at the start, caret right after. */
function commandQuery(text: string, caret: number): string | null {
  const m = /^\/([a-z0-9_-]{0,32})$/i.exec(text.slice(0, caret));
  return m && caret === text.length ? m[1]!.toLowerCase() : null;
}

/**
 * Suggests slash commands while typing "/name" at the start of the text:
 * arrow keys choose, Enter or Tab completes "/name ", Escape closes.
 */
export function useCommandPicker({
  workspaceId,
  input,
  onChange,
}: {
  workspaceId: string | undefined;
  input: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const commands = useQuery({
    ...commandsQuery(workspaceId ?? ''),
    enabled: query !== null && !!workspaceId,
  });
  const candidates =
    query === null
      ? []
      : (commands.data ?? []).filter((c) => c.trigger.startsWith(query)).slice(0, 8);
  const open = candidates.length > 0;

  /** Call after every change of the text or caret. */
  const update = () => {
    const el = input.current;
    if (!el) return;
    const next = commandQuery(el.value, el.selectionStart ?? el.value.length);
    if (next !== query) setActive(0);
    setQuery(next);
  };

  // The caret goes after the inserted text right after it renders, before
  // the next key press (a frame later, fast typing would land elsewhere).
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const pick = (trigger: string) => {
    const next = `/${trigger} `;
    caret.current = next.length;
    onChange(next);
    setQuery(null);
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
      pick(candidates[active]!.trigger);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setQuery(null);
      return true;
    }
    return false;
  };

  const current = candidates[active];
  const popup = open ? (
    <div className="absolute bottom-full start-0 z-20 mb-1 w-96 max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <ul id={listId} role="listbox" aria-label={t('commands.label')}>
        {candidates.map((c, i) => (
          <li
            key={c.trigger}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c.trigger);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'flex min-h-target cursor-default flex-col justify-center rounded-md px-2 py-1 text-sm',
              i === active && 'bg-accent text-accent-foreground',
            )}
          >
            <span className="truncate">
              <span className="font-mono font-medium">/{c.trigger}</span>
              {c.hint && <span className="ms-2 text-xs text-muted-foreground">{c.hint}</span>}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {c.builtin
                ? t(`commands.builtin.${c.trigger}`, { defaultValue: c.description })
                : c.description}
            </span>
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status">
        {current &&
          t('commands.active', { command: `/${current.trigger}`, count: candidates.length })}
      </p>
    </div>
  ) : null;

  return { open, listId, popup, update, onKeyDown, close: () => setQuery(null) };
}
