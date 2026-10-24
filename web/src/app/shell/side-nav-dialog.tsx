// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentType, ReactNode } from 'react';
import { DialogContent, DialogDescription, DialogTitle } from '@cenacle/ui/components/dialog';
import { cn } from '@cenacle/ui/lib/utils';

export interface SideNavItem<K extends string> {
  key: K;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;
  /** A count shown at the end (members, connections). */
  count?: number;
}

export interface SideNavGroup<K extends string> {
  label?: string;
  items: SideNavItem<K>[];
}

/**
 * A wide dialog with its sections on the left (v0.29): Settings and the
 * workspace settings. The sections are tabs; the panel on the right has a
 * title and a line on what it holds. On narrow screens the sections scroll
 * in a row above the panel.
 */
export function SideNavDialog<K extends string>({
  id,
  title,
  subtitle,
  groups,
  value,
  onChange,
  description,
  aside,
  footer,
  children,
}: {
  /** Prefix of the tab and panel ids. */
  id: string;
  title: string;
  subtitle?: ReactNode;
  groups: SideNavGroup<K>[];
  value: K;
  onChange: (key: K) => void;
  /** The line under the panel title. */
  description?: ReactNode;
  /** Links under the sections (they leave the dialog). */
  aside?: ReactNode;
  /** At the foot of the navigation. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const items = groups.flatMap((g) => g.items);
  const current = items.find((i) => i.key === value);
  return (
    <DialogContent className="grid h-[min(90svh,52rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-5xl md:grid-cols-[236px_minmax(0,1fr)] md:grid-rows-1">
      <nav
        aria-label={title}
        className="flex min-h-0 flex-col gap-1 border-b bg-secondary px-3 pt-5 pb-3 md:border-e md:border-b-0"
      >
        <div className="px-2.5 pb-3 max-md:pe-10">
          <DialogTitle className="text-[17px] font-semibold">{title}</DialogTitle>
          <DialogDescription className="text-xs">{subtitle}</DialogDescription>
        </div>
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label={title}
          className="flex gap-1 overflow-x-auto max-md:pb-1 md:flex-col md:overflow-visible"
        >
          {groups.map((g, gi) => (
            <div key={gi} className="contents md:flex md:flex-col md:gap-0.5">
              {g.label && (
                <p className="px-2.5 pt-4 pb-1 text-xs font-semibold text-muted-foreground max-md:hidden">
                  {g.label}
                </p>
              )}
              {g.items.map(({ key, label, icon: Icon, count }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`${id}-tab-${key}`}
                  aria-selected={value === key}
                  aria-controls={`${id}-panel`}
                  tabIndex={value === key ? 0 : -1}
                  onClick={() => onChange(key)}
                  onKeyDown={(e) => {
                    const i = items.findIndex((x) => x.key === key);
                    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
                    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
                    if (!forward && !back) return;
                    e.preventDefault();
                    const next = items[(i + (forward ? 1 : items.length - 1)) % items.length]!.key;
                    onChange(next);
                    document.getElementById(`${id}-tab-${next}`)?.focus();
                  }}
                  className={cn(
                    'flex h-8 min-h-target shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 text-start text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    value === key ? 'bg-accent font-semibold' : 'hover:bg-muted',
                  )}
                >
                  <Icon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                  {label}
                  {count !== undefined && (
                    <span className="ms-auto ps-2 font-mono text-xs font-normal text-muted-foreground">
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
        {aside && <div className="mt-4 flex flex-col gap-0.5 max-md:hidden">{aside}</div>}
        {footer && (
          <div className="mt-auto px-2.5 pt-4 text-xs text-muted-foreground max-md:hidden">
            {footer}
          </div>
        )}
      </nav>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${value}`}
        className="flex min-h-0 flex-col"
      >
        <header className="border-b px-8 pt-5 pb-4 max-md:hidden">
          <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">
            {current?.label}
          </h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-2 pb-8 max-sm:px-4">{children}</div>
      </div>
    </DialogContent>
  );
}
