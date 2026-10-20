// SPDX-License-Identifier: Apache-2.0
// Source: shadcn/ui (style "base-nova", Base UI primitives) https://ui.shadcn.com
// Author: shadcn and contributors. License: MIT.
// Adapted for Cenacle: target size tokens, i18n labels, local imports.
import * as React from 'react';
import { cn } from '../lib/utils';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // Generic wrapper: callers associate the control via htmlFor or nesting.
    // eslint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
