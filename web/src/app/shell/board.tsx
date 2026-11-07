// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { cn } from '@cenacle/ui/lib/utils';
import { useCountFormat } from './count-format';

export interface BoardColumn {
  label: ReactNode;
  /** A fixed width (Tailwind class such as "w-[96px]"); none: takes the rest. */
  width?: string;
  align?: 'end';
}

/**
 * A board (v0.29, after the departures board): fixed columns under a Forest
 * header, rows in day or state groups. Wide screens only; views stack their
 * rows on phones.
 */
export function Board({
  label,
  columns,
  minWidth = 'min-w-[56rem]',
  children,
}: {
  label?: string;
  columns: BoardColumn[];
  minWidth?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-rule-strong bg-background">
      <table
        aria-label={label}
        className={cn('w-full table-fixed border-collapse text-start', minWidth)}
      >
        <colgroup>
          {columns.map((c, i) => (
            <col key={i} className={c.width} />
          ))}
        </colgroup>
        <thead className="bg-brand-forest text-brand-bone">
          <tr className="h-10 text-[12.5px]">
            {columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className={cn('px-3 font-medium', c.align === 'end' && 'text-end')}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/** A group of rows under a label ("Today", "Overdue") with an optional count. */
export function BoardGroup({
  label,
  count,
  span,
  children,
}: {
  label?: ReactNode;
  count?: number;
  span: number;
  children: ReactNode;
}) {
  const format = useCountFormat();
  return (
    <tbody>
      {label !== undefined && (
        <tr>
          <th
            scope="colgroup"
            colSpan={span}
            className="border-t bg-secondary px-3 py-1.5 text-[12.5px] font-semibold"
          >
            {label}
            {count !== undefined && (
              <span className="ms-2 font-normal tabular-nums text-muted-foreground">
                {format(count)}
              </span>
            )}
          </th>
        </tr>
      )}
      {children}
    </tbody>
  );
}

/** Tabs with a Brass underline above a board, with counts and a note at the end. */
export function BoardTabs<K extends string>({
  label,
  tabs,
  value,
  onChange,
  note,
}: {
  label: string;
  tabs: { key: K; label: string; count?: number }[];
  value: K;
  onChange: (key: K) => void;
  note?: ReactNode;
}) {
  const format = useCountFormat();
  return (
    <div className="flex items-end gap-1 border-b">
      <div role="tablist" aria-label={label} className="flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            aria-selected={value === tab.key}
            tabIndex={value === tab.key ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const i = tabs.findIndex((x) => x.key === value);
              const next =
                tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!.key;
              onChange(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
            className={cn(
              '-mb-px flex h-10 min-h-target items-center gap-2 border-b-2 px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              value === tab.key
                ? 'border-primary font-semibold text-foreground'
                : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="text-[13px] font-normal text-muted-foreground tabular-nums">
                {format(tab.count)}
              </span>
            )}
          </button>
        ))}
      </div>
      {note && <p className="mb-2.5 ms-auto text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** A section heading above a board: title, count and actions. */
export function BoardSection({
  title,
  count,
  actions,
  children,
}: {
  title: string;
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex min-h-8 items-center gap-2.5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {count !== undefined && <span className="text-[13px] text-muted-foreground">{count}</span>}
        {actions && <div className="ms-auto flex gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
