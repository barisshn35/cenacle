// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from '@cenacle/ui/lib/utils';

/** A row; "lit" rows need the reader (unseen, overdue). */
export const boardRow = (lit = false) =>
  cn('h-[62px] border-t align-middle', lit ? 'bg-muted' : 'bg-background');

export const boardCell = 'px-3 py-2';
