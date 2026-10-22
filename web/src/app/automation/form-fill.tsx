// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { useActiveWorkspace } from '../chat/active-workspace';
import { workspaceMembersQuery } from '../chat/workspaces';
import type { Form, FormField, FormValues } from './automation';

const control =
  'min-h-target w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type Values = Record<string, string | string[]>;

/** One field of a form, with its label, help and the right kind of input. */
function Field({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ws = useActiveWorkspace().id;
  const members = useQuery({
    ...workspaceMembersQuery(ws ?? ''),
    enabled: !!ws && field.kind === 'person',
  });
  const text = typeof value === 'string' ? value : '';
  const list = Array.isArray(value) ? value : [];
  const help = field.help ? `${id}-help` : undefined;
  const label = (
    <>
      {field.label}
      {field.required && <span aria-hidden> *</span>}
      {field.required && <span className="sr-only"> ({t('automation.fill.required')})</span>}
    </>
  );
  let input;
  switch (field.kind) {
    case 'textarea':
      input = (
        <textarea
          id={id}
          rows={4}
          maxLength={4000}
          required={field.required}
          aria-describedby={help}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={control}
        />
      );
      break;
    case 'number':
    case 'date':
    case 'text':
      input = (
        <Input
          id={id}
          type={field.kind === 'text' ? 'text' : field.kind}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          maxLength={field.kind === 'text' ? 300 : undefined}
          required={field.required}
          aria-describedby={help}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'select':
      input = (
        <select
          id={id}
          required={field.required}
          aria-describedby={help}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={control}
        >
          <option value="">{t('automation.fill.choose')}</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'person':
      input = (
        <select
          id={id}
          required={field.required}
          aria-describedby={help}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={control}
        >
          <option value="">{t('automation.fill.choosePerson')}</option>
          {(members.data ?? [])
            .filter((m) => !m.user.is_bot)
            .map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.display_name}
              </option>
            ))}
        </select>
      );
      break;
    case 'multiselect':
      return (
        <fieldset aria-describedby={help} className="grid gap-1">
          <legend className="mb-1 text-sm font-medium">{label}</legend>
          {(field.options ?? []).map((o) => (
            <label key={o} data-target className="flex min-h-target items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-target-exempt
                className="size-4 accent-primary"
                checked={list.includes(o)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o))
                }
              />
              {o}
            </label>
          ))}
          {field.help && (
            <p id={help} className="text-xs text-muted-foreground">
              {field.help}
            </p>
          )}
        </fieldset>
      );
    case 'checkbox':
      return (
        <div className="grid gap-1">
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-target-exempt
              className="size-4 accent-primary"
              aria-describedby={help}
              checked={text === 'true'}
              onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            />
            {label}
          </label>
          {field.help && (
            <p id={help} className="text-xs text-muted-foreground">
              {field.help}
            </p>
          )}
        </div>
      );
  }
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {input}
      {field.help && (
        <p id={help} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      )}
    </div>
  );
}

/** A form to fill in: its fields, and a button that sends the answers. */
export function FormFillDialog({
  form,
  open,
  onOpenChange,
  onSubmit,
  submitLabel,
}: {
  form: Form;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: FormValues) => Promise<unknown>;
  submitLabel?: string;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" data-testid="form-fill">
        <DialogHeader>
          <DialogTitle>{form.name}</DialogTitle>
          <DialogDescription>{form.description || t('automation.fill.hint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            onSubmit(values as FormValues)
              .then(() => {
                setValues({});
                onOpenChange(false);
              })
              .catch((err: unknown) =>
                setError(
                  (err instanceof ApiError && err.problem.detail) || t('automation.fill.failed'),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {form.fields.map((f) => (
            <Field
              key={f.id}
              field={f}
              value={values[f.id]}
              onChange={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))}
            />
          ))}
          {error && <InlineError title={error} problem={{ status: 400 }} />}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {submitLabel ?? t('automation.fill.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
