// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CopyIcon, DownloadIcon, NotebookPenIcon, SparklesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { calls } from '@cenacle/core';
import { apiFetch } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Answer, Writing } from '../ai/ai-ui';
import { failure, useAI, useAIGate, type AIAnswer } from '../ai/ai';
import { useProfile } from '../profile/profiles';
import { errorCode, useCall } from './state';

/** Keeps notes of the call or stops (everyone sees it). */
export function NotesButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('calls');
  const call = useCall((s) => s.call);
  if (!call) return null;
  const on = !!call.notes_on;
  return (
    <Button
      variant="outline"
      aria-pressed={on}
      disabled={disabled}
      onClick={() =>
        void calls
          .setNotes(call.id, !on)
          .catch((error: unknown) => useCall.setState({ error: errorCode(error) }))
      }
    >
      <NotebookPenIcon data-icon="inline-start" />
      {on ? t('notes.stop') : t('notes.start')}
    </Button>
  );
}

/** In the call: notes are being kept, and who turned them on. */
export function NotesStatus({ selfID }: { selfID: string }) {
  const { t } = useTranslation('calls');
  const call = useCall((s) => s.call);
  const by = useProfile(call?.notes_by ?? undefined)?.display_name;
  if (!call?.notes_on) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-sm font-medium"
      data-testid="notes-on"
    >
      <NotebookPenIcon aria-hidden className="size-4" />
      {call.notes_by === selfID
        ? t('notes.onByYou')
        : by
          ? t('notes.onBy', { name: by })
          : t('notes.on')}
    </p>
  );
}

function Speaker({ id }: { id: string | null }) {
  const { t } = useTranslation('calls');
  const name = useProfile(id ?? undefined)?.display_name;
  return <>{id ? (name ?? '…') : t('notes.erased')}</>;
}

/** The notes of a call that ended: the lines, copy, download and an AI summary. */
export function NotesDialog({
  callID,
  open,
  onOpenChange,
}: {
  callID: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation('calls');
  const ai = useAI();
  const gate = useAIGate();
  const [summary, setSummary] = useState<AIAnswer | null>(null);
  const notes = useQuery({
    queryKey: ['calls', 'notes', callID],
    queryFn: () => calls.notes(callID),
    enabled: open,
  });
  const summarize = useMutation({
    mutationFn: () =>
      apiFetch<AIAnswer>(
        `/api/calls/${encodeURIComponent(callID)}/notes/summary?language=${encodeURIComponent(i18n.language)}`,
        { method: 'POST' },
      ),
    onSuccess: setSummary,
  });
  const clock = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const lines = notes.data?.lines ?? [];
  // Copy and download use the names on screen.
  const asText = () =>
    Array.from(document.querySelectorAll('[data-note-line]'))
      .map((el) => (el as HTMLElement).innerText.replace(/\n+/g, ' '))
      .join('\n');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="call-notes">
        <DialogHeader>
          <DialogTitle>{t('notes.title')}</DialogTitle>
          <DialogDescription>{t('notes.hint')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!lines.length}
            onClick={() =>
              navigator.clipboard.writeText(asText()).then(
                () => toast.success(t('notes.copied')),
                () => toast.error(t('notes.copyFailed')),
              )
            }
          >
            <CopyIcon data-icon="inline-start" />
            {t('notes.copy')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!lines.length}
            onClick={() => {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([asText()], { type: 'text/plain' }));
              a.download = `cenacle-call-notes-${callID.slice(0, 8)}.txt`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
            }}
          >
            <DownloadIcon data-icon="inline-start" />
            {t('notes.download')}
          </Button>
          {ai && (
            <Button
              variant="outline"
              size="sm"
              disabled={!lines.length || summarize.isPending}
              onClick={() => gate(() => summarize.mutate())}
            >
              <SparklesIcon data-icon="inline-start" />
              {t('notes.summarize')}
            </Button>
          )}
        </div>
        {summarize.isPending && <Writing lines={3} />}
        {summarize.isError && <InlineError problem={failure(summarize.error)} />}
        {summary && <Answer answer={summary} />}
        {notes.isPending ? (
          <Writing lines={2} />
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('notes.none')}</p>
        ) : (
          <ol className="grid gap-1.5 text-sm">
            {lines.map((l, i) => (
              <li key={i} data-note-line className="grid grid-cols-[4rem_1fr] gap-2">
                <time dateTime={l.said_at} className="text-muted-foreground tabular-nums">
                  {clock.format(new Date(l.said_at))}
                </time>
                <span>
                  <span className="me-1.5 font-semibold">
                    <Speaker id={l.user_id} />:
                  </span>
                  {l.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
