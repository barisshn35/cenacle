// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SparklesIcon, WandSparklesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cenacle/ui/components/dropdown-menu';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { useSession } from '../auth/session';
import { useActiveWorkspace } from '../chat/active-workspace';
import { MessageBody } from '../chat/markdown/message-body';
import { reloadWorkspaces, type Workspace } from '../chat/workspaces';
import {
  ask,
  compose,
  setWorkspaceAI,
  summarize,
  useAI,
  useAIAvailable,
  type AIAnswer,
  type ComposeAction,
} from './ai';

/** The AI's answer, marked as written by AI. */
function Answer({ answer }: { answer: AIAnswer }) {
  const { t } = useTranslation();
  const self = useSession().user.id;
  return (
    <div className="flex flex-col gap-3" data-testid="ai-answer">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SparklesIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
        {t('ai.written')}
      </p>
      <MessageBody body={answer.text} mentions={[]} selfId={self} />
      {answer.sources.length > 0 && (
        <details className="text-sm">
          <summary className="min-h-target cursor-pointer text-muted-foreground">
            {t('ai.sources', { count: answer.sources.length })}
          </summary>
          <ol className="mt-1 flex list-decimal flex-col gap-1 pl-6">
            {answer.sources.map((s) => (
              <li key={s.message_id}>
                <Link
                  to="/c/$channelId"
                  params={{ channelId: s.channel_id }}
                  search={{ m: s.message_id }}
                  className="underline-offset-2 hover:underline"
                >
                  {s.author_name}
                  {s.channel_name && ` (#${s.channel_name})`}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function failure(err: unknown) {
  return err instanceof ApiError ? err.problem : { status: 500 };
}

/** The channel header's (or a thread's) "Summarize" button and its result. */
export function SummarizeButton({ channelId, rootId }: { channelId: string; rootId?: string }) {
  const { t, i18n } = useTranslation();
  const on = useAI();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<AIAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!on) return null;
  const run = () => {
    setOpen(true);
    setAnswer(null);
    setError(null);
    summarize(channelId, i18n.language, rootId).then(setAnswer).catch(setError);
  };
  const label = rootId ? t('ai.summarizeThread') : t('ai.summarize');
  return (
    <>
      <Button variant="ghost" size="icon" aria-label={label} onClick={run}>
        <SparklesIcon strokeWidth={1.75} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>{t('ai.summaryHint')}</DialogDescription>
          </DialogHeader>
          {answer ? (
            <Answer answer={answer} />
          ) : error ? (
            <InlineError title={t('ai.failed')} problem={failure(error)} />
          ) : (
            <div role="status" aria-label={t('ai.working')} className="flex flex-col gap-2">
              <Skeleton className="h-4" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

const ACTIONS: ComposeAction[] = ['improve', 'shorter', 'formal', 'friendly'];

/** The composer's "Rewrite" menu: the draft, rewritten, replaces it only when chosen. */
export function RewriteMenu({ text, onUse }: { text: string; onUse: (text: string) => void }) {
  const { t, i18n } = useTranslation();
  const on = useAI();
  const ws = useActiveWorkspace().id;
  const [result, setResult] = useState<AIAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  if (!on || !ws) return null;
  const run = (action: ComposeAction, language?: string) => {
    setOpen(true);
    setResult(null);
    setError(null);
    compose(ws, text, action, language).then(setResult).catch(setError);
  };
  const other = i18n.language.startsWith('tr') ? 'en' : 'tr';
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('ai.rewrite')}
              disabled={!text.trim()}
            />
          }
        >
          <WandSparklesIcon strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {ACTIONS.map((a) => (
            <DropdownMenuItem key={a} onClick={() => run(a)}>
              {t(`ai.actions.${a}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => run('translate', other)}>
            {t('ai.translateTo', { language: t(`ai.languages.${other}`) })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('ai.rewrite')}</DialogTitle>
            <DialogDescription>{t('ai.rewriteHint')}</DialogDescription>
          </DialogHeader>
          {result ? (
            <Answer answer={result} />
          ) : error ? (
            <InlineError title={t('ai.failed')} problem={failure(error)} />
          ) : (
            <div role="status" aria-label={t('ai.working')} className="flex flex-col gap-2">
              <Skeleton className="h-4" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('ai.keepMine')}
            </Button>
            <Button
              type="button"
              disabled={!result}
              onClick={() => {
                if (result) onUse(result.text);
                setOpen(false);
              }}
            >
              {t('ai.useThis')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Ask a question of the messages one can read (a home view). */
export function AskPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const ws = useActiveWorkspace().id;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AIAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ws || question.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    ask(ws, question.trim(), i18n.language)
      .then(setAnswer)
      .catch(setError)
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-4" data-testid="ask">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor={`${id}-q`}>{t('ai.askLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-q`}
            value={question}
            minLength={3}
            maxLength={500}
            onChange={(e) => setQuestion(e.target.value)}
            aria-describedby={`${id}-hint`}
          />
          <Button type="submit" disabled={busy || question.trim().length < 3} aria-busy={busy}>
            <SparklesIcon strokeWidth={1.75} />
            {t('ai.ask')}
          </Button>
        </div>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t('ai.askHint')}
        </p>
      </form>
      {busy && (
        <div role="status" aria-label={t('ai.working')} className="flex flex-col gap-2">
          <Skeleton className="h-4" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      )}
      {error !== null && <InlineError title={t('ai.failed')} problem={failure(error)} />}
      {answer &&
        (answer.sources.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('ai.noSources')}
          </p>
        ) : (
          <Answer answer={answer} />
        ))}
    </div>
  );
}

/** In the workspace settings (admins, where the operator configured a model). */
export function WorkspaceAIForm({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const id = useId();
  const available = useAIAvailable();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!available) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 border-t pt-4">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('ai.settingsTitle')}
      </h3>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="size-target shrink-0 accent-primary"
          checked={!!workspace.ai_enabled}
          disabled={busy}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setBusy(true);
            void setWorkspaceAI(workspace.id, e.target.checked)
              .then(() => reloadWorkspaces(queryClient))
              .finally(() => setBusy(false));
          }}
        />
        <span>{t('ai.turnOn')}</span>
      </label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('ai.settingsHint')}
      </p>
    </section>
  );
}
