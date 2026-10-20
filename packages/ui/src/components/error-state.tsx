// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { CircleAlertIcon, OctagonAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import { errorKindFor, type ProblemLike } from '../lib/errors';

/**
 * The four parts of every user-facing error (UX plan 4.4):
 * what happened, why (if known), what the user can do, and a code/request ID.
 * Any part left out is filled from the localized texts of `problem`.
 */
export interface ErrorParts {
  title?: ReactNode;
  reason?: ReactNode;
  action?: ReactNode;
  code?: string;
  requestId?: string;
  /** Problem details from the API; used to pick localized defaults. */
  problem?: ProblemLike;
  /** Values for message placeholders, e.g. { seconds: 30 } for rate limits. */
  values?: Record<string, unknown>;
}

function useErrorParts(parts: ErrorParts) {
  const { t } = useTranslation();
  const kind = parts.problem ? errorKindFor(parts.problem) : undefined;
  const msg = (part: 'title' | 'reason' | 'action') =>
    kind ? t(`ui:errors.${kind}.${part}`, parts.values ?? {}) : undefined;
  return {
    title: parts.title ?? msg('title'),
    reason: parts.reason ?? msg('reason'),
    action: parts.action ?? msg('action'),
    code: parts.code ?? parts.problem?.code,
    requestId: parts.requestId ?? parts.problem?.request_id,
  };
}

function Reference({ code, requestId }: { code?: string; requestId?: string }) {
  const { t } = useTranslation();
  if (!code && !requestId) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {code && (
        <div className="flex gap-1">
          <dt>{t('ui:errors.codeLabel')}:</dt>
          <dd className="font-mono select-all">{code}</dd>
        </div>
      )}
      {requestId && (
        <div className="flex gap-1">
          <dt>{t('ui:errors.requestIdLabel')}:</dt>
          <dd className="font-mono select-all">{requestId}</dd>
        </div>
      )}
    </dl>
  );
}

export interface ErrorStateProps extends ErrorParts {
  /** Buttons such as "Try again"; rendered after the action text. */
  actions?: ReactNode;
  /**
   * "alert" for errors that need attention now (default), "status" for
   * informational states that should not interrupt a screen reader.
   */
  politeness?: 'alert' | 'status';
  className?: string;
}

/** Full error state for a page, panel or empty region. */
export function ErrorState({
  actions,
  politeness = 'alert',
  className,
  ...parts
}: ErrorStateProps) {
  const { title, reason, action, code, requestId } = useErrorParts(parts);
  return (
    <div
      role={politeness}
      data-slot="error-state"
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <OctagonAlertIcon aria-hidden className="size-8 text-destructive" strokeWidth={1.75} />
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-medium text-foreground">{title}</p>
        {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
        {action && <p className="text-sm text-foreground">{action}</p>}
      </div>
      {actions && <div className="flex flex-wrap justify-center gap-2">{actions}</div>}
      <Reference code={code} requestId={requestId} />
    </div>
  );
}

export interface InlineErrorProps extends ErrorParts {
  id?: string;
  politeness?: 'alert' | 'status';
  className?: string;
  children?: ReactNode;
}

/**
 * Compact error next to a field, message row or inside a dialog. Use `id`
 * with aria-describedby on the related control.
 */
export function InlineError({
  id,
  politeness = 'alert',
  className,
  children,
  ...parts
}: InlineErrorProps) {
  const { title, reason, action, code, requestId } = useErrorParts(parts);
  return (
    <div
      id={id}
      role={politeness}
      data-slot="inline-error"
      className={cn('flex items-start gap-2 text-sm', className)}
    >
      <CircleAlertIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-destructive"
        strokeWidth={1.75}
      />
      <div className="flex flex-col gap-1">
        <p className="text-foreground">
          <span className="font-medium">{title}</span>
          {reason && <> {reason}</>}
          {action && <> {action}</>}
        </p>
        {children}
        <Reference code={code} requestId={requestId} />
      </div>
    </div>
  );
}
