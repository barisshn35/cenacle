// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { cn } from '@cenacle/ui/lib/utils';

type Action = components['schemas']['AttachmentAction'];
import { showResult, useBotDialog, type BotDialog, type Result } from './interactions-state';

const post = <T,>(url: string, body: unknown) =>
  apiFetch<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The buttons and menus of a bot's card; using one asks the bot. */
export function CardActions({
  message,
  index,
  actions,
}: {
  message: { id: string; channel_id: string };
  index: number;
  actions: Action[];
}) {
  const { t } = useTranslation();
  const run = useMutation({
    mutationFn: (a: { action_id: string; value?: string }) =>
      post<Result>(`/api/channels/${message.channel_id}/messages/${message.id}/actions`, {
        attachment: index,
        ...a,
      }),
    onSuccess: showResult,
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.problem.code === 'no_interactions'
          ? t('interactions.unavailable')
          : t('interactions.failed'),
      ),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="card-actions">
      {actions.map((a) =>
        a.type === 'button' ? (
          <Button
            key={a.id}
            size="sm"
            variant={
              a.style === 'primary' ? 'default' : a.style === 'danger' ? 'destructive' : 'outline'
            }
            disabled={run.isPending}
            aria-busy={(run.isPending && run.variables?.action_id === a.id) || undefined}
            onClick={() => run.mutate({ action_id: a.id })}
          >
            {a.text}
          </Button>
        ) : (
          <select
            key={a.id}
            aria-label={a.text}
            defaultValue=""
            disabled={run.isPending}
            onChange={(e) => {
              if (e.target.value) run.mutate({ action_id: a.id, value: e.target.value });
              e.target.value = '';
            }}
            className="h-8 min-h-target rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="" disabled>
              {a.text}
            </option>
            {a.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.text}
              </option>
            ))}
          </select>
        ),
      )}
    </div>
  );
}

/** The dialog an app opened: its fields, checked here and by the app. */
export function BotDialogHost() {
  const dialog = useBotDialog((s) => s.dialog);
  const open = useBotDialog((s) => s.open);
  if (!dialog) return null;
  return <BotDialogForm key={dialog.id} dialog={dialog} onClose={() => open(null)} />;
}

function BotDialogForm({ dialog, onClose }: { dialog: BotDialog; onClose: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      dialog.elements.map((e) => [e.name, e.value ?? (e.type === 'checkbox' ? 'false' : '')]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: () => post<Result>(`/api/dialogs/${dialog.id}`, { values }),
    onSuccess: (result) => {
      if (result.errors && Object.keys(result.errors).length > 0) {
        setErrors(result.errors);
        return;
      }
      onClose();
      showResult({ ...result, dialog: result.dialog });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    submit.mutate();
  };
  const set = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }));
  const field =
    'w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog.title}</DialogTitle>
          <DialogDescription>{t('interactions.dialogFrom')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          {dialog.elements.map((e) => {
            const fid = `${id}-${e.name}`;
            const err = errors[e.name];
            const describedBy =
              [err ? `${fid}-error` : '', e.help ? `${fid}-help` : ''].filter(Boolean).join(' ') ||
              undefined;
            const common = {
              id: fid,
              'aria-invalid': err ? true : undefined,
              'aria-describedby': describedBy,
              required: !e.optional,
            };
            return (
              <div key={e.name} className="grid gap-1.5">
                {e.type === 'checkbox' ? (
                  <div className="flex min-h-target items-center gap-2 text-sm">
                    <input
                      {...common}
                      type="checkbox"
                      className="size-4"
                      checked={values[e.name] === 'true'}
                      onChange={(ev) => set(e.name, ev.target.checked ? 'true' : 'false')}
                    />
                    <label htmlFor={fid}>{e.label}</label>
                  </div>
                ) : (
                  <>
                    <Label htmlFor={fid}>
                      {e.label}
                      {e.optional && (
                        <span className="font-normal text-muted-foreground">
                          {' '}
                          {t('interactions.optional')}
                        </span>
                      )}
                    </Label>
                    {e.type === 'textarea' ? (
                      <textarea
                        {...common}
                        rows={4}
                        maxLength={e.max_length ?? 3000}
                        placeholder={e.placeholder}
                        value={values[e.name]}
                        onChange={(ev) => set(e.name, ev.target.value)}
                        className={cn(field, 'resize-y')}
                      />
                    ) : e.type === 'select' ? (
                      <select
                        {...common}
                        value={values[e.name]}
                        onChange={(ev) => set(e.name, ev.target.value)}
                        className={cn(field, 'h-9')}
                      >
                        <option value="">{e.placeholder ?? t('interactions.choose')}</option>
                        {e.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.text}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        {...common}
                        type={e.type === 'date' ? 'date' : 'text'}
                        maxLength={e.max_length ?? 150}
                        placeholder={e.placeholder}
                        value={values[e.name]}
                        onChange={(ev) => set(e.name, ev.target.value)}
                      />
                    )}
                  </>
                )}
                {e.help && (
                  <p id={`${fid}-help`} className="text-xs text-muted-foreground">
                    {e.help}
                  </p>
                )}
                {err && (
                  <p id={`${fid}-error`} className="text-xs text-destructive">
                    {err}
                  </p>
                )}
              </div>
            );
          })}
          {submit.isError && (
            <InlineError
              problem={submit.error instanceof ApiError ? submit.error.problem : { status: 500 }}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('glossary.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={submit.isPending}
              aria-busy={submit.isPending || undefined}
            >
              {dialog.submit_label}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
