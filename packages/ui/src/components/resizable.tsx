// SPDX-License-Identifier: Apache-2.0
// Source: shadcn/ui (style "base-nova", Base UI primitives) https://ui.shadcn.com
// Author: shadcn and contributors. License: MIT.
// Adapted for Cenacle: target size tokens, i18n labels, local imports.
import { cn } from '../lib/utils';
import * as ResizablePrimitive from 'react-resizable-panels';
import { useTranslation } from 'react-i18next';

function ResizablePanelGroup({
  className,
  // Pointer hit areas of the handles follow the project target sizes.
  resizeTargetMinimumSize = { fine: 28, coarse: 44 },
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      data-slot="resizable-panel-group"
      className={cn('flex h-full w-full aria-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ResizablePrimitive.Separator
      aria-label={t('ui:resize.handle')}
      data-slot="resizable-handle"
      className={cn(
        'relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-target after:-translate-x-1/2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-target aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
export { usePanelRef, type PanelImperativeHandle } from 'react-resizable-panels';
