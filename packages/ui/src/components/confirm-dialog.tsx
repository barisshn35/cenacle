// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from './button';
import { InlineError } from './error-state';
import { Input } from './input';
import { cn } from '../lib/utils';

/**
 * Severity levels of the destructive action pattern (UX plan 4.1):
 * - s2: affects others but is reversible (archive, disable, remove member)
 * - s3: irreversible or touches secrets (delete permanently, rotate token)
 * S1 actions never open a dialog; they run immediately with an undo toast.
 */
export type ConfirmSeverity = 's2' | 's3';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  severity: ConfirmSeverity;
  /** What will happen, e.g. "Archive #ops-alerts?" */
  title: ReactNode;
  /** Who is affected and whether/how it can be undone. */
  description: ReactNode;
  /** Optional impact summary (counts of affected bots, messages, ...). */
  impact?: ReactNode;
  /** Verb label of the confirm button, e.g. "Archive channel". Never "OK". */
  confirmLabel: string;
  /** Defaults to the localized "Cancel". */
  cancelLabel?: string;
  /**
   * Adds "This cannot be undone." Set only when nothing (not even an admin
   * restore within the retention period) can bring the data back.
   */
  irreversible?: boolean;
  /**
   * S3 only: the user must type this exact text (usually the object's name)
   * before the confirm button is enabled.
   */
  confirmationText?: string;
  /** Runs the action. The dialog closes when it resolves and stays open on error. */
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirmation dialog for S2/S3 actions.
 *
 * - Focus starts on Cancel, so Enter never triggers the destructive action.
 * - Esc always cancels (except while the action is running).
 * - An irreversible action (or S3) is marked in red as well as by icon and verb
 *   text; a reversible one keeps the neutral button.
 * - Buttons act on click (pointer-up) and are disabled while running,
 *   which also prevents double submission.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  severity,
  title,
  description,
  impact,
  confirmLabel,
  cancelLabel,
  confirmationText,
  irreversible = false,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);

  const needsTyping = severity === 's3' && confirmationText !== undefined;
  // Red is kept for what cannot be undone; a reversible action (archive,
  // disable, remove) is asked about calmly.
  const destructive = irreversible || severity === 's3';
  const matches = !needsTyping || typed === confirmationText;

  const reset = () => {
    setTyped('');
    setFailed(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && running.current) return; // keep the dialog while the action runs
    if (!next) reset();
    onOpenChange(next);
  };

  const confirm = async () => {
    if (running.current || !matches) return;
    running.current = true;
    setPending(true);
    setFailed(false);
    try {
      await onConfirm();
      running.current = false;
      reset();
      onOpenChange(false);
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          data-slot="confirm-dialog-overlay"
          className="fixed inset-0 isolate z-50 bg-black/20 duration-(--duration-fast) supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <AlertDialog.Popup
          data-slot="confirm-dialog"
          data-severity={severity}
          data-destructive={destructive || undefined}
          initialFocus={cancelRef}
          aria-busy={pending || undefined}
          className="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-5 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 duration-(--duration-base) outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <div className="flex gap-3">
            <span
              aria-hidden
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full',
                destructive ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground',
              )}
            >
              <TriangleAlertIcon className="size-5" strokeWidth={1.75} />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <AlertDialog.Title className="text-base leading-snug font-medium">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description
                render={<div />}
                className="flex flex-col gap-1.5 text-muted-foreground"
              >
                {description}
                {irreversible && (
                  <p className="font-medium text-foreground">{t('ui:confirm.irreversible')}</p>
                )}
              </AlertDialog.Description>
            </div>
          </div>

          {impact && (
            <div
              data-slot="confirm-dialog-impact"
              className="rounded-lg border bg-muted/50 px-3 py-2.5 text-sm"
            >
              {impact}
            </div>
          )}

          {needsTyping && (
            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-sm">
                <Trans
                  i18nKey="ui:confirm.typeToConfirm"
                  values={{ name: confirmationText }}
                  components={{ strong: <strong className="font-mono font-semibold" /> }}
                />
              </label>
              <Input
                id={inputId}
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter must never submit a destructive action by accident.
                  if (e.key === 'Enter') e.preventDefault();
                }}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={pending}
                aria-describedby={typed && !matches ? hintId : undefined}
                aria-invalid={typed !== '' && !matches ? true : undefined}
                className="font-mono"
              />
              {typed !== '' && !matches && (
                <p id={hintId} className="text-xs text-muted-foreground">
                  {t('ui:confirm.mismatch')}
                </p>
              )}
            </div>
          )}

          {failed && <InlineError id={errorId} title={t('ui:confirm.failed')} />}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialog.Close
              ref={cancelRef}
              disabled={pending}
              render={<Button variant="outline" />}
            >
              {cancelLabel ?? t('ui:confirm.cancel')}
            </AlertDialog.Close>
            <Button
              data-slot="confirm-dialog-action"
              className={cn(
                destructive &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/40',
              )}
              disabled={pending || !matches}
              aria-describedby={failed ? errorId : undefined}
              onClick={confirm}
            >
              {pending ? (
                <Loader2Icon aria-hidden className="animate-spin" strokeWidth={1.75} />
              ) : (
                <TriangleAlertIcon aria-hidden strokeWidth={1.75} />
              )}
              {confirmLabel}
              {pending && <span className="sr-only">{t('ui:confirm.working')}</span>}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
