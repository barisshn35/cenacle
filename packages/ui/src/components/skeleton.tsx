// SPDX-License-Identifier: AGPL-3.0-only
// Source: shadcn/ui (style "base-nova", Base UI primitives) https://ui.shadcn.com
// Author: shadcn and contributors. License: MIT.
// Adapted for Cenacle: target size tokens, i18n labels, local imports.
import { cn } from '../lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };
