// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Undo2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';

/** UX plan 4.1: undo toasts stay at least 10 seconds. */
export const MIN_UNDO_DURATION_MS = 10_000;

export interface UndoToastOptions {
  /** What just happened, e.g. "Message deleted." */
  message: ReactNode;
  /** Reverts the action on the server. May be async. */
  onUndo: () => void | Promise<void>;
  /** Display time in ms; values below 10 s are raised to 10 s. */
  duration?: number;
  /** Stable id to replace an earlier toast for the same object. */
  id?: string | number;
}

function UndoToastView({
  message,
  onUndo,
  onDone,
}: Pick<UndoToastOptions, 'message' | 'onUndo'> & { onDone: () => void }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  return (
    <div
      role="status"
      data-slot="undo-toast"
      className="flex w-[min(var(--width,356px),calc(100vw-2rem))] items-center gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
    >
      <p className="flex-1">{message}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={async () => {
          setPending(true);
          try {
            await onUndo();
          } finally {
            setPending(false);
            onDone();
          }
        }}
      >
        <Undo2Icon aria-hidden strokeWidth={1.75} />
        {t('ui:undo.action')}
      </Button>
    </div>
  );
}

/**
 * Shows an "Undo" toast for S1/S2 actions. It never takes focus; the Undo
 * button is reachable with the keyboard (Alt+T focuses the toast region) and
 * the timer pauses while the toast is hovered or focused.
 */
export function showUndoToast({ message, onUndo, duration, id }: UndoToastOptions) {
  const ms = Math.max(duration ?? MIN_UNDO_DURATION_MS, MIN_UNDO_DURATION_MS);
  return toast.custom(
    (toastId) => (
      <UndoToastView message={message} onUndo={onUndo} onDone={() => toast.dismiss(toastId)} />
    ),
    { duration: ms, ...(id !== undefined ? { id } : {}) },
  );
}
