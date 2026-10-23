// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { cn } from '@cenacle/ui/lib/utils';
import { useIsMobile } from '@cenacle/ui/hooks/use-mobile';
import { Board, BoardGroup, BoardSection } from '../shell/board';
import { boardCell, boardRow } from '../shell/board-styles';
import { useActiveWorkspace } from '../chat/active-workspace';
import { directoryQuery, isConversation } from '../chat/data';
import { workspaceMembersQuery } from '../chat/workspaces';
import {
  archiveForm,
  archiveWorkflow,
  createForm,
  createWorkflow,
  fieldId,
  formsQuery,
  rotateWorkflowWebhook,
  runsQuery,
  updateForm,
  updateWorkflow,
  workflowsQuery,
  type Form,
  type FormField,
  type Workflow,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowTrigger,
} from './automation';
import { dateLocale } from '../../i18n/time-format';

const control =
  'min-h-target w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function move<T>(list: T[], i: number, by: number): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

function failed(t: (k: string) => string) {
  return (err: unknown) =>
    toast.error((err instanceof ApiError && err.problem.detail) || t('automation.admin.failed'));
}

/** Up, down and remove buttons for an item of a list (no dragging needed). */
function ItemTools({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 gap-0.5">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('automation.admin.moveUp', { name: label })}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('automation.admin.moveDown', { name: label })}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('automation.admin.remove', { name: label })}
        onClick={onRemove}
      >
        <Trash2Icon strokeWidth={1.75} />
      </Button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

// --- forms -----------------------------------------------------------------------

const FIELD_KINDS = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'person',
] as const;

function FormEditor({
  workspaceId,
  form,
  onClose,
}: {
  workspaceId: string;
  form: Form | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(form?.name ?? '');
  const [description, setDescription] = useState(form?.description ?? '');
  const [fields, setFields] = useState<FormField[]>(
    form?.fields ?? [{ id: '', label: '', kind: 'text', required: true }],
  );
  const patch = (i: number, p: Partial<FormField>) =>
    setFields((cur) => cur.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const save = useMutation({
    mutationFn: () => {
      const taken: string[] = [];
      const clean = fields.map((f) => {
        const id = f.id || fieldId(f.label, taken);
        taken.push(id);
        return {
          ...f,
          id,
          options:
            f.kind === 'select' || f.kind === 'multiselect'
              ? (f.options ?? []).map((o) => o.trim()).filter(Boolean)
              : undefined,
        };
      });
      const input = { name: name.trim(), description: description.trim(), fields: clean };
      return form ? updateForm(form.id, input) : createForm(workspaceId, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['forms', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['shortcuts'] });
      toast.success(t('automation.admin.formSaved'));
      onClose();
    },
    onError: failed(t),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
        data-testid="form-editor"
      >
        <DialogHeader>
          <DialogTitle>
            {form ? t('automation.admin.editForm') : t('automation.admin.newForm')}
          </DialogTitle>
          <DialogDescription>{t('automation.admin.formHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Row label={t('automation.admin.name')}>
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={120}
                required
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Row>
          <Row label={t('automation.admin.description')}>
            {(id) => (
              <Input
                id={id}
                value={description}
                maxLength={1000}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Row>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold">{t('automation.admin.fields')}</legend>
            {fields.map((f, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-[10px] border border-rule-strong p-3"
                data-testid="field-editor"
              >
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Row label={t('automation.admin.fieldLabel', { n: i + 1 })}>
                      {(id) => (
                        <Input
                          id={id}
                          value={f.label}
                          maxLength={200}
                          required
                          onChange={(e) => patch(i, { label: e.target.value })}
                        />
                      )}
                    </Row>
                  </div>
                  <ItemTools
                    label={f.label || String(i + 1)}
                    index={i}
                    count={fields.length}
                    onMove={(by) => setFields((cur) => move(cur, i, by))}
                    onRemove={() => setFields((cur) => cur.filter((_, j) => j !== i))}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Row label={t('automation.admin.fieldKind')}>
                    {(id) => (
                      <select
                        id={id}
                        className={control}
                        value={f.kind}
                        onChange={(e) => patch(i, { kind: e.target.value as FormField['kind'] })}
                      >
                        {FIELD_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`automation.kinds.${k}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Row>
                  <label
                    data-target
                    className="flex min-h-target items-center gap-2 self-end text-sm"
                  >
                    <input
                      type="checkbox"
                      data-target-exempt
                      className="size-4 accent-primary"
                      checked={f.required}
                      onChange={(e) => patch(i, { required: e.target.checked })}
                    />
                    {t('automation.admin.required')}
                  </label>
                </div>
                {(f.kind === 'select' || f.kind === 'multiselect') && (
                  <Row label={t('automation.admin.options')}>
                    {(id) => (
                      <textarea
                        id={id}
                        rows={3}
                        className={control}
                        value={(f.options ?? []).join('\n')}
                        onChange={(e) => patch(i, { options: e.target.value.split('\n') })}
                      />
                    )}
                  </Row>
                )}
                <Row label={t('automation.admin.help')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={f.help ?? ''}
                      maxLength={300}
                      onChange={(e) => patch(i, { help: e.target.value })}
                    />
                  )}
                </Row>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={fields.length >= 30}
              onClick={() =>
                setFields((cur) => [...cur, { id: '', label: '', kind: 'text', required: false }])
              }
            >
              <PlusIcon strokeWidth={1.75} />
              {t('automation.admin.addField')}
            </Button>
          </fieldset>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !name.trim() || fields.length === 0}>
              {t('automation.admin.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- workflows -------------------------------------------------------------------

/** Variables steps can use (the ones a trigger does not set are empty). */
const VARIABLES = [
  'trigger.user',
  'trigger.user_name',
  'trigger.channel',
  'trigger.message',
  'form.<field>',
  'approval.status',
  'approval.by',
  'approval.comment',
  'webhook.<field>',
  'workflow.name',
];

const TRIGGERS = ['manual', 'member_joined', 'reaction', 'keyword', 'schedule', 'webhook'] as const;
const STEP_KINDS = ['message', 'dm', 'form', 'approval', 'delay', 'http'] as const;

function newStep(kind: WorkflowStep['kind'], taken: string[]): WorkflowStep {
  let n = taken.length + 1;
  while (taken.includes(`step_${n}`)) n++;
  const step: WorkflowStep = { id: `step_${n}`, kind };
  if (kind === 'delay') step.minutes = 60;
  return step;
}

function TriggerFields({
  trigger,
  onChange,
  channels,
}: {
  trigger: WorkflowTrigger;
  onChange: (t: WorkflowTrigger) => void;
  channels: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const needsChannel = trigger.kind !== 'manual' && trigger.kind !== 'webhook';
  const zones = (() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  })();
  return (
    <fieldset className="grid gap-3 rounded-[10px] border border-rule-strong p-3">
      <legend className="px-1 text-sm font-semibold">{t('automation.admin.trigger')}</legend>
      <Row label={t('automation.admin.triggerKind')}>
        {(id) => (
          <select
            id={id}
            className={control}
            value={trigger.kind}
            onChange={(e) => {
              const kind = e.target.value as WorkflowTrigger['kind'];
              onChange({
                kind,
                channel_id: trigger.channel_id,
                ...(kind === 'schedule'
                  ? {
                      schedule: {
                        every: 'weekday',
                        time: '09:00',
                        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      },
                    }
                  : {}),
              });
            }}
          >
            {TRIGGERS.map((k) => (
              <option key={k} value={k}>
                {t(`automation.triggers.${k}`)}
              </option>
            ))}
          </select>
        )}
      </Row>
      <Row
        label={needsChannel ? t('automation.admin.channel') : t('automation.admin.channelOptional')}
      >
        {(id) => (
          <select
            id={id}
            className={control}
            value={trigger.channel_id ?? ''}
            required={needsChannel}
            onChange={(e) => onChange({ ...trigger, channel_id: e.target.value || null })}
          >
            <option value="">
              {trigger.kind === 'manual'
                ? t('automation.admin.anyChannel')
                : t('automation.admin.chooseChannel')}
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        )}
      </Row>
      {trigger.kind === 'reaction' && (
        <Row label={t('automation.admin.emoji')}>
          {(id) => (
            <Input
              id={id}
              value={trigger.emoji ?? ''}
              maxLength={64}
              required
              onChange={(e) => onChange({ ...trigger, emoji: e.target.value.trim() })}
            />
          )}
        </Row>
      )}
      {trigger.kind === 'keyword' && (
        <Row label={t('automation.admin.keyword')}>
          {(id) => (
            <Input
              id={id}
              value={trigger.keyword ?? ''}
              maxLength={100}
              required
              onChange={(e) => onChange({ ...trigger, keyword: e.target.value })}
            />
          )}
        </Row>
      )}
      {trigger.kind === 'schedule' && trigger.schedule && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Row label={t('automation.admin.every')}>
            {(id) => (
              <select
                id={id}
                className={control}
                value={trigger.schedule!.every}
                onChange={(e) =>
                  onChange({
                    ...trigger,
                    schedule: {
                      ...trigger.schedule!,
                      every: e.target.value as 'day' | 'weekday' | 'week',
                      weekday: e.target.value === 'week' ? 1 : undefined,
                    },
                  })
                }
              >
                {(['day', 'weekday', 'week'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`automation.every.${k}`)}
                  </option>
                ))}
              </select>
            )}
          </Row>
          {trigger.schedule.every === 'week' && (
            <Row label={t('automation.admin.weekday')}>
              {(id) => (
                <select
                  id={id}
                  className={control}
                  value={trigger.schedule!.weekday ?? 1}
                  onChange={(e) =>
                    onChange({
                      ...trigger,
                      schedule: { ...trigger.schedule!, weekday: Number(e.target.value) },
                    })
                  }
                >
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <option key={d} value={d}>
                      {t(`automation.weekdays.${d}`)}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          )}
          <Row label={t('automation.admin.time')}>
            {(id) => (
              <Input
                id={id}
                type="time"
                value={trigger.schedule!.time}
                required
                onChange={(e) =>
                  onChange({ ...trigger, schedule: { ...trigger.schedule!, time: e.target.value } })
                }
              />
            )}
          </Row>
          <Row label={t('automation.admin.timeZone')}>
            {(id) => (
              <select
                id={id}
                className={control}
                value={trigger.schedule!.time_zone}
                onChange={(e) =>
                  onChange({
                    ...trigger,
                    schedule: { ...trigger.schedule!, time_zone: e.target.value },
                  })
                }
              >
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            )}
          </Row>
        </div>
      )}
    </fieldset>
  );
}

function StepFields({
  step,
  onChange,
  channels,
  people,
  forms,
}: {
  step: WorkflowStep;
  onChange: (s: WorkflowStep) => void;
  channels: { id: string; name: string }[];
  people: { id: string; display_name: string }[];
  forms: Form[];
}) {
  const { t } = useTranslation();
  const textRow = (label: string) => (
    <Row label={label}>
      {(id) => (
        <>
          <textarea
            id={id}
            rows={3}
            maxLength={4000}
            required
            className={control}
            value={step.text ?? ''}
            aria-describedby={`${id}-vars`}
            onChange={(e) => onChange({ ...step, text: e.target.value })}
          />
          <p id={`${id}-vars`} className="text-xs text-muted-foreground">
            {t('automation.admin.variables')}{' '}
            {VARIABLES.map((v, i) => (
              <span key={v}>
                {i > 0 && ', '}
                <code>{`{{${v}}}`}</code>
              </span>
            ))}
          </p>
        </>
      )}
    </Row>
  );
  switch (step.kind) {
    case 'message':
      return (
        <>
          <Row label={t('automation.admin.postIn')}>
            {(id) => (
              <select
                id={id}
                className={control}
                value={step.channel_id ?? ''}
                onChange={(e) => onChange({ ...step, channel_id: e.target.value || null })}
              >
                <option value="">{t('automation.admin.triggerChannel')}</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            )}
          </Row>
          {textRow(t('automation.admin.message'))}
        </>
      );
    case 'dm':
      return (
        <>
          <Row label={t('automation.admin.sendTo')}>
            {(id) => (
              <select
                id={id}
                className={control}
                value={step.to ?? ''}
                onChange={(e) => onChange({ ...step, to: e.target.value || null })}
              >
                <option value="">{t('automation.admin.starter')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            )}
          </Row>
          {textRow(t('automation.admin.message'))}
        </>
      );
    case 'form':
      return (
        <Row label={t('automation.admin.form')}>
          {(id) => (
            <select
              id={id}
              className={control}
              required
              value={step.form_id ?? ''}
              onChange={(e) => onChange({ ...step, form_id: e.target.value || null })}
            >
              <option value="">{t('automation.admin.chooseForm')}</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </Row>
      );
    case 'approval':
      return (
        <>
          {textRow(t('automation.admin.request'))}
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">{t('automation.admin.approvers')}</legend>
            <div className="max-h-40 overflow-y-auto rounded-lg border p-2">
              {people.map((p) => (
                <label
                  key={p.id}
                  data-target
                  className="flex min-h-target items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    data-target-exempt
                    className="size-4 accent-primary"
                    checked={(step.approvers ?? []).includes(p.id)}
                    onChange={(e) =>
                      onChange({
                        ...step,
                        approvers: e.target.checked
                          ? [...(step.approvers ?? []), p.id]
                          : (step.approvers ?? []).filter((x) => x !== p.id),
                      })
                    }
                  />
                  {p.display_name}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    case 'delay':
      return (
        <Row label={t('automation.admin.minutes')}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={10080}
              required
              value={step.minutes ?? 60}
              onChange={(e) => onChange({ ...step, minutes: Number(e.target.value) })}
            />
          )}
        </Row>
      );
    case 'http':
      return (
        <Row label={t('automation.admin.url')}>
          {(id) => (
            <Input
              id={id}
              type="url"
              required
              placeholder="https://"
              value={step.url ?? ''}
              onChange={(e) => onChange({ ...step, url: e.target.value })}
            />
          )}
        </Row>
      );
  }
}

function WorkflowEditor({
  workspaceId,
  workflow,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  workflow: Workflow | null;
  onClose: () => void;
  onCreated: (w: Workflow) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const channels = (useQuery(directoryQuery(workspaceId)).data ?? []).filter(
    (c) => !isConversation(c) && !c.archived,
  );
  const people = (useQuery(workspaceMembersQuery(workspaceId)).data ?? [])
    .filter((m) => !m.user.is_bot)
    .map((m) => ({ id: m.user.id, display_name: m.user.display_name }));
  const forms = useQuery(formsQuery(workspaceId)).data ?? [];
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [trigger, setTrigger] = useState<WorkflowTrigger>(workflow?.trigger ?? { kind: 'manual' });
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow?.steps ?? [newStep('message', [])]);
  const [adding, setAdding] = useState<WorkflowStep['kind']>('message');
  const save = useMutation({
    mutationFn: () => {
      const input: WorkflowInput = {
        name: name.trim(),
        description: description.trim(),
        enabled,
        trigger,
        steps,
      };
      return workflow ? updateWorkflow(workflow.id, input) : createWorkflow(workspaceId, input);
    },
    onSuccess: (w) => {
      void queryClient.invalidateQueries({ queryKey: ['workflows', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['shortcuts'] });
      toast.success(t('automation.admin.workflowSaved'));
      onClose();
      if (w.webhook_url || w.secret) onCreated(w);
    },
    onError: failed(t),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
        data-testid="workflow-editor"
      >
        <DialogHeader>
          <DialogTitle>
            {workflow ? t('automation.admin.editWorkflow') : t('automation.admin.newWorkflow')}
          </DialogTitle>
          <DialogDescription>{t('automation.admin.workflowHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Row label={t('automation.admin.name')}>
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={120}
                required
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Row>
          <Row label={t('automation.admin.description')}>
            {(id) => (
              <Input
                id={id}
                value={description}
                maxLength={1000}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Row>
          <label data-target className="flex min-h-target items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-target-exempt
              className="size-4 accent-primary"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('automation.admin.enabled')}
          </label>
          <TriggerFields trigger={trigger} onChange={setTrigger} channels={channels} />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-semibold">{t('automation.admin.steps')}</legend>
            <ol className="flex flex-col gap-3">
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  className="grid gap-2 rounded-[10px] border border-rule-strong p-3"
                  data-testid="step-editor"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex-1 text-sm font-medium">
                      {t(`automation.steps.${s.kind}`)}
                    </span>
                    <ItemTools
                      label={`${i + 1}. ${t(`automation.steps.${s.kind}`)}`}
                      index={i}
                      count={steps.length}
                      onMove={(by) => setSteps((cur) => move(cur, i, by))}
                      onRemove={() => setSteps((cur) => cur.filter((_, j) => j !== i))}
                    />
                  </div>
                  <StepFields
                    step={s}
                    channels={channels}
                    people={people}
                    forms={forms}
                    onChange={(next) => setSteps((cur) => cur.map((x, j) => (j === i ? next : x)))}
                  />
                </li>
              ))}
            </ol>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Row label={t('automation.admin.stepKind')}>
                  {(id) => (
                    <select
                      id={id}
                      className={control}
                      value={adding}
                      onChange={(e) => setAdding(e.target.value as WorkflowStep['kind'])}
                    >
                      {STEP_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {t(`automation.steps.${k}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Row>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={steps.length >= 25}
                onClick={() =>
                  setSteps((cur) => [
                    ...cur,
                    newStep(
                      adding,
                      cur.map((s) => s.id),
                    ),
                  ])
                }
              >
                <PlusIcon strokeWidth={1.75} />
                {t('automation.admin.addStep')}
              </Button>
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending || !name.trim() || steps.length === 0}>
              {t('automation.admin.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shown once: a webhook workflow's address and the secret of its requests. */
function Secrets({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const { t } = useTranslation();
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(t('automation.admin.copied')),
      () => undefined,
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="workflow-secrets">
        <DialogHeader>
          <DialogTitle>{t('automation.admin.secretsTitle')}</DialogTitle>
          <DialogDescription>{t('automation.admin.secretsHint')}</DialogDescription>
        </DialogHeader>
        {workflow.webhook_url && (
          <div className="grid gap-1">
            <p className="text-sm font-medium">{t('automation.admin.webhookUrl')}</p>
            <code className="rounded-md bg-muted px-2 py-1.5 text-xs break-all">
              {workflow.webhook_url}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => copy(workflow.webhook_url!)}
            >
              {t('automation.admin.copy')}
            </Button>
          </div>
        )}
        {workflow.secret && (
          <div className="grid gap-1">
            <p className="text-sm font-medium">{t('automation.admin.secret')}</p>
            <code className="rounded-md bg-muted px-2 py-1.5 text-xs break-all">
              {workflow.secret}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => copy(workflow.secret!)}
            >
              {t('automation.admin.copy')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Runs({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const runs = useQuery(runsQuery(workflow.id));
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('automation.admin.runsOf', { name: workflow.name })}</DialogTitle>
          <DialogDescription>{t('automation.admin.runsHint')}</DialogDescription>
        </DialogHeader>
        {runs.isPending ? (
          <Skeleton className="h-24" />
        ) : (runs.data ?? []).length === 0 ? (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            {t('automation.admin.noRuns')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="runs">
            {runs.data!.map((r) => (
              <li key={r.id} className="rounded-lg border px-3 py-2 text-sm">
                <p className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{t(`automation.status.${r.status}`)}</span>
                  <span className="text-muted-foreground">
                    {when.format(new Date(r.created_at))}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('automation.admin.runProgress', { step: r.step, steps: r.steps })}
                  {r.trigger_user && ` · ${r.trigger_user.display_name}`}
                </p>
                {r.error && <p className="mt-1 text-xs text-destructive">{r.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The workspace's workflows and forms (owners and admins). */
export function WorkflowsPage() {
  const { t } = useTranslation();
  const ws = useActiveWorkspace();
  const queryClient = useQueryClient();
  const workflows = useQuery(workflowsQuery(ws.admin ? ws.id : undefined));
  const forms = useQuery(formsQuery(ws.id));
  const mobile = useIsMobile();
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const [editingForm, setEditingForm] = useState<Form | 'new' | null>(null);
  const [runs, setRuns] = useState<Workflow | null>(null);
  const [secrets, setSecrets] = useState<Workflow | null>(null);
  const [archiving, setArchiving] = useState<{
    kind: 'workflow' | 'form';
    id: string;
    name: string;
  } | null>(null);
  if (!ws.id) return null;
  if (!ws.admin) {
    return (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        {t('automation.admin.onlyAdmins')}
      </p>
    );
  }
  const triggerText = (w: Workflow) => t(`automation.triggers.${w.trigger.kind}`);
  const wfActions = (w: Workflow) => (
    <span className="flex flex-wrap justify-end gap-1.5">
      <Button size="sm" variant="outline" onClick={() => setRuns(w)}>
        {t('automation.admin.runs')}
      </Button>
      {w.trigger.kind === 'webhook' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => rotateWorkflowWebhook(w.id).then(setSecrets, failed(t))}
        >
          {t('automation.admin.newAddress')}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => setEditing(w)}>
        {t('automation.admin.edit')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setArchiving({ kind: 'workflow', id: w.id, name: w.name })}
      >
        {t('automation.admin.archive')}
      </Button>
    </span>
  );
  const formActions = (f: Form) => (
    <span className="flex flex-wrap justify-end gap-1.5">
      <Button size="sm" variant="outline" onClick={() => setEditingForm(f)}>
        {t('automation.admin.edit')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setArchiving({ kind: 'form', id: f.id, name: f.name })}
      >
        {t('automation.admin.archive')}
      </Button>
    </span>
  );
  const state = (w: Workflow) => (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px]',
        w.enabled ? 'font-semibold' : 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          w.enabled ? 'bg-success' : 'border border-rule-strong',
        )}
      />
      {w.enabled ? t('automation.admin.on') : t('automation.admin.off')}
    </span>
  );
  return (
    <div className="flex flex-col gap-8" data-testid="workflows-page">
      <BoardSection
        title={t('automation.admin.workflows')}
        count={workflows.data?.length}
        actions={
          <Button onClick={() => setEditing('new')}>
            <PlusIcon strokeWidth={1.75} />
            {t('automation.admin.newWorkflow')}
          </Button>
        }
      >
        {workflows.isPending ? (
          <Skeleton className="h-16" />
        ) : (workflows.data ?? []).length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground max-sm:px-4">
            {t('automation.admin.noWorkflows')}
          </p>
        ) : mobile ? (
          <ul className="flex flex-col border-t">
            {workflows.data!.map((w) => (
              <li
                key={w.id}
                data-testid="workflow"
                className="flex flex-col gap-1.5 border-b px-4 py-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">{w.name}</span>
                  <span className="ml-auto">{state(w)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {triggerText(w)} · {t('automation.admin.stepCount', { count: w.steps.length })}
                </span>
                <div className="flex justify-start">{wfActions(w)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Board
            label={t('automation.admin.workflows')}
            minWidth="min-w-[52rem]"
            columns={[
              { label: t('automation.admin.columns.workflow') },
              { label: t('automation.admin.columns.steps'), width: 'w-[88px]' },
              { label: t('automation.admin.columns.state'), width: 'w-[96px]' },
              { label: t('automation.admin.columns.actions'), width: 'w-[360px]', align: 'end' },
            ]}
          >
            <BoardGroup span={4}>
              {workflows.data!.map((w) => (
                <tr key={w.id} data-testid="workflow" className={cn(boardRow(), 'text-sm')}>
                  <td className={boardCell}>
                    <span className="block font-semibold">{w.name}</span>
                    <span className="block text-[13px] text-muted-foreground">
                      {triggerText(w)}
                    </span>
                  </td>
                  <td className={cn(boardCell, 'font-mono')}>{w.steps.length}</td>
                  <td className={boardCell}>{state(w)}</td>
                  <td className={boardCell}>{wfActions(w)}</td>
                </tr>
              ))}
            </BoardGroup>
          </Board>
        )}
      </BoardSection>

      <BoardSection
        title={t('automation.admin.forms')}
        count={forms.data?.length}
        actions={
          <Button variant="outline" onClick={() => setEditingForm('new')}>
            <PlusIcon strokeWidth={1.75} />
            {t('automation.admin.newForm')}
          </Button>
        }
      >
        {(forms.data ?? []).length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground max-sm:px-4">
            {t('automation.admin.noForms')}
          </p>
        ) : mobile ? (
          <ul className="flex flex-col border-t">
            {forms.data!.map((f) => (
              <li
                key={f.id}
                data-testid="form"
                className="flex flex-col gap-1.5 border-b px-4 py-3 text-sm"
              >
                <span className="font-semibold">{f.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('automation.admin.fieldCount', { count: f.fields.length })}
                </span>
                <div className="flex justify-start">{formActions(f)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <Board
            label={t('automation.admin.forms')}
            minWidth="min-w-[40rem]"
            columns={[
              { label: t('automation.admin.columns.form') },
              { label: t('automation.admin.columns.fields'), width: 'w-[140px]' },
              { label: t('automation.admin.columns.actions'), width: 'w-[200px]', align: 'end' },
            ]}
          >
            <BoardGroup span={3}>
              {forms.data!.map((f) => (
                <tr key={f.id} data-testid="form" className={cn(boardRow(), 'text-sm')}>
                  <td className={cn(boardCell, 'font-semibold')}>{f.name}</td>
                  <td className={cn(boardCell, 'text-[13px] text-muted-foreground')}>
                    {t('automation.admin.fieldCount', { count: f.fields.length })}
                  </td>
                  <td className={boardCell}>{formActions(f)}</td>
                </tr>
              ))}
            </BoardGroup>
          </Board>
        )}
      </BoardSection>

      {editing && (
        <WorkflowEditor
          workspaceId={ws.id}
          workflow={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={setSecrets}
        />
      )}
      {editingForm && (
        <FormEditor
          workspaceId={ws.id}
          form={editingForm === 'new' ? null : editingForm}
          onClose={() => setEditingForm(null)}
        />
      )}
      {runs && <Runs workflow={runs} onClose={() => setRuns(null)} />}
      {secrets && <Secrets workflow={secrets} onClose={() => setSecrets(null)} />}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        severity="s2"
        title={t('automation.admin.archiveTitle', { name: archiving?.name ?? '' })}
        description={t('automation.admin.archiveHint')}
        confirmLabel={t('automation.admin.archive')}
        onConfirm={async () => {
          if (!archiving) return;
          await (archiving.kind === 'workflow'
            ? archiveWorkflow(archiving.id)
            : archiveForm(archiving.id));
          void queryClient.invalidateQueries({
            queryKey: [archiving.kind === 'workflow' ? 'workflows' : 'forms', ws.id],
          });
          void queryClient.invalidateQueries({ queryKey: ['shortcuts'] });
          setArchiving(null);
        }}
      />
    </div>
  );
}
