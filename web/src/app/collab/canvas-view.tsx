// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, PencilIcon, PencilLineIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import type { ProblemLike } from '@cenacle/ui/lib/errors';
import { useSession } from '../auth/session';
import { MessageBody } from '../chat/markdown/message-body';
import { sinceText } from '../profile/format';
import { canvasQuery, saveCanvas, startEditing, stopEditing, type Canvas } from './collab';

/** How often the turn to edit is renewed while editing (it lasts two minutes). */
const RENEW_MS = 60_000;

/** A canvas: Markdown read by everyone, edited by one person at a time. */
export function CanvasView({ canvasId }: { canvasId: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const query = useQuery(canvasQuery(canvasId));
  const canvas = query.data;
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<{ title: string; problem: ProblemLike } | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = draft !== null;
  const editingRef = useRef(editing);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    editingRef.current = editing;
    // The Edit button is gone: the text takes the focus.
    if (editing) bodyRef.current?.focus();
  }, [editing]);

  const set = (c: Canvas) => queryClient.setQueryData(canvasQuery(canvasId).queryKey, c);
  const fail = (title: string) => (err: unknown) => {
    const problem: ProblemLike = err instanceof ApiError ? err.problem : { status: 500 };
    setError({ title, problem });
    // Whoever holds the turn shows in the header.
    if (problem.code === 'canvas_busy') void query.refetch();
  };

  // Keep the turn while editing; give it back when leaving.
  useEffect(() => {
    if (!editing) return;
    const timer = setInterval(() => {
      startEditing(canvasId).catch(fail(t('collab.canvas.turnLost')));
    }, RENEW_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, canvasId]);
  useEffect(
    () => () => {
      if (editingRef.current) void stopEditing(canvasId).catch(() => undefined);
    },
    [canvasId],
  );

  if (query.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!canvas) {
    return (
      <div className="p-6">
        <InlineError
          title={t('collab.canvas.loadFailed')}
          problem={query.error instanceof ApiError ? query.error.problem : { status: 500 }}
        />
      </div>
    );
  }

  const other = canvas.editing_by && canvas.editing_by.id !== self ? canvas.editing_by : null;
  const edit = () => {
    setError(null);
    startEditing(canvasId)
      .then((c) => {
        set({ ...c, can_edit: canvas.can_edit });
        setDraft(c.body);
        setPreview(false);
      })
      .catch(fail(t('collab.canvas.editFailed')));
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
    void stopEditing(canvasId).catch(() => undefined);
  };
  const save = () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    saveCanvas(canvasId, draft, canvas.version)
      .then((c) => {
        set(c);
        setDraft(null);
      })
      .catch(fail(t('collab.canvas.saveFailed')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article
        aria-labelledby={`${id}-title`}
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6"
        data-testid="canvas"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id={`${id}-title`} className="font-display text-2xl font-medium">
            {canvas.title}
          </h2>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground" role="status">
            {other
              ? t('collab.canvas.editingBy', { name: other.display_name })
              : canvas.updated_by && canvas.body
                ? t('collab.canvas.editedBy', {
                    name: canvas.updated_by.display_name,
                    when: sinceText(new Date(canvas.updated_at), i18n.language),
                  })
                : null}
          </p>
          {editing ? (
            <div className="flex gap-2">
              <Button variant="ghost" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
                <EyeIcon strokeWidth={1.75} />
                {t('collab.canvas.preview')}
              </Button>
              <Button variant="outline" onClick={cancel}>
                {t('collab.cancel')}
              </Button>
              <Button onClick={save} disabled={busy} aria-busy={busy}>
                {t('collab.canvas.save')}
              </Button>
            </div>
          ) : (
            canvas.can_edit && (
              <Button variant="outline" onClick={edit} disabled={!!other}>
                <PencilIcon strokeWidth={1.75} />
                {t('collab.canvas.edit')}
              </Button>
            )
          )}
        </header>
        {error && (
          <InlineError
            title={error.title}
            problem={error.problem}
            reason={
              error.problem.code === 'canvas_changed'
                ? t('collab.canvas.changedReason')
                : error.problem.code === 'canvas_busy'
                  ? t('collab.canvas.busyReason')
                  : undefined
            }
          >
            {error.problem.code === 'canvas_changed' && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Their text is not lost: it goes to the clipboard.
                    if (draft) {
                      void navigator.clipboard
                        ?.writeText(draft)
                        .then(() => toast.success(t('collab.canvas.copied')))
                        .catch(() => undefined);
                    }
                    void query.refetch();
                    cancel();
                  }}
                >
                  {t('collab.canvas.loadLatest')}
                </Button>
              </div>
            )}
          </InlineError>
        )}
        {editing && !preview ? (
          <>
            <label htmlFor={`${id}-body`} className="sr-only">
              {t('collab.canvas.text')}
            </label>
            <textarea
              id={`${id}-body`}
              value={draft}
              ref={bodyRef}
              maxLength={50000}
              onChange={(e) => setDraft(e.target.value)}
              aria-describedby={`${id}-hint`}
              className="min-h-[60vh] w-full resize-y rounded-lg border border-input bg-background p-4 text-[0.9375rem] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {t('collab.canvas.hint')}
            </p>
          </>
        ) : (draft ?? canvas.body) ? (
          <div className="rounded-lg [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&>div>*+*]:mt-3">
            <MessageBody body={draft ?? canvas.body} mentions={[]} selfId={self} document />
          </div>
        ) : (
          <div
            role="status"
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center"
          >
            <PencilLineIcon
              aria-hidden
              className="size-6 text-muted-foreground"
              strokeWidth={1.75}
            />
            <p className="text-sm text-muted-foreground">
              {canvas.can_edit ? t('collab.canvas.emptyEdit') : t('collab.canvas.empty')}
            </p>
          </div>
        )}
      </article>
    </div>
  );
}
