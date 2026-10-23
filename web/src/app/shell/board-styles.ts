// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from '@cenacle/ui/lib/utils';

/** A row; "lit" rows need the reader (unseen, overdue). */
export const boardRow = (lit = false) =>
  cn('h-[62px] border-t align-middle', lit ? 'bg-muted' : 'bg-background');

export const boardCell = 'px-3 py-2';

/** A link in the navigation of a SideNavDialog that leaves it. */
export const sideNavLink =
  'flex h-8 min-h-target items-center gap-2.5 rounded-[7px] px-2.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50';
