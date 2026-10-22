// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileTextIcon, ZapIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { addMessage } from '../chat/data';
import {
  shortcutsQuery,
  startWorkflow,
  submitForm,
  submitTask,
  type Form,
  type Task,
} from './automation';
import { FormFillDialog } from './form-fill';

/** The composer's button for the channel's workflows and forms. */
export function Shortcuts({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const data = useQuery(shortcutsQuery(channelId)).data;
  if (!data || (data.workflows.length === 0 && data.forms.length === 0)) return null;

  const start = (id: string) => {
    setOpen(false);
    startWorkflow(id, channelId)
      .then((r) => {
        if (r.task?.form) setTask(r.task);
        else toast.success(t('automation.shortcuts.started'));
      })
      .catch((err: unknown) =>
        toast.error(
          (err instanceof ApiError && err.problem.detail) || t('automation.shortcuts.failed'),
        ),
      );
  };

  const item =
    'flex min-h-target w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50';
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('automation.shortcuts.open')}
            />
          }
        >
          <ZapIcon strokeWidth={1.75} />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-80" data-testid="shortcuts">
          <PopoverTitle className="sr-only">{t('automation.shortcuts.open')}</PopoverTitle>
          {data.workflows.length > 0 && (
            <section aria-labelledby="sc-workflows">
              <h3 id="sc-workflows" className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {t('automation.shortcuts.workflows')}
              </h3>
              <ul>
                {data.workflows.map((w) => (
                  <li key={w.id}>
                    <button type="button" className={item} onClick={() => start(w.id)}>
                      <ZapIcon aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
                      <span>
                        <span className="block font-medium">{w.name}</span>
                        {w.description && (
                          <span className="block text-xs text-muted-foreground">
                            {w.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.forms.length > 0 && (
            <section aria-labelledby="sc-forms" className="mt-2">
              <h3 id="sc-forms" className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {t('automation.shortcuts.forms')}
              </h3>
              <ul>
                {data.forms.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={item}
                      onClick={() => {
                        setOpen(false);
                        setForm(f);
                      }}
                    >
                      <FileTextIcon
                        aria-hidden
                        className="mt-0.5 size-4 shrink-0"
                        strokeWidth={1.75}
                      />
                      <span className="font-medium">{f.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </PopoverContent>
      </Popover>
      {form && (
        <FormFillDialog
          form={form}
          open
          onOpenChange={(o) => !o && setForm(null)}
          onSubmit={(values) =>
            submitForm(form.id, channelId, values).then((m) => addMessage(queryClient, m))
          }
        />
      )}
      {task?.form && (
        <FormFillDialog
          form={task.form}
          open
          onOpenChange={(o) => !o && setTask(null)}
          onSubmit={(values) =>
            submitTask(task.id, values).then(() => toast.success(t('automation.shortcuts.sent')))
          }
        />
      )}
    </>
  );
}
