// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageUpIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { DEFAULT_CUSTOM_THEME, FONT_TEMPLATES, THEME_PRESETS } from '@cenacle/ui/theme';
import { CustomThemeEditor } from '../appearance/custom-theme-editor';
import { setWorkspaceAppearance } from '../appearance/appearance';
import { initials } from '../auth/sign-out';
import {
  deleteWorkspaceIcon,
  reloadWorkspaces,
  setWorkspaceIcon,
  updateWorkspace,
  type Workspace,
} from './workspaces';

const MAX_UPLOAD = 5 * 1024 * 1024;

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Icon, name and description of a workspace (owners and admins). */
export function WorkspaceDetailsForm({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { name: useId(), description: useId() };
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description);
  const file = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const failed = (err: unknown) =>
    toast.error(
      err instanceof ApiError && (err.status === 422 || err.status === 413)
        ? t('profile.pictureInvalid')
        : t('channels.changeFailed'),
    );
  const save = useMutation({
    mutationFn: () =>
      updateWorkspace(workspace.id, { name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      void reloadWorkspaces(queryClient);
      toast.success(t('workspaces.saved'));
    },
    onError: failed,
  });
  const icon = useMutation({
    mutationFn: async (f: File | null) => {
      if (f) await setWorkspaceIcon(workspace.id, f);
      else await deleteWorkspaceIcon(workspace.id);
    },
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: failed,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate();
  };

  return (
    <form onSubmit={submit} className="grid gap-3" data-testid="workspace-details">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-sidebar-accent text-base font-semibold"
        >
          {workspace.icon_url ? (
            <img src={workspace.icon_url} alt="" className="size-full object-cover" />
          ) : (
            initials(workspace.name)
          )}
        </span>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (f.size > MAX_UPLOAD) toast.error(t('profile.pictureTooLarge'));
            else icon.mutate(f);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={icon.isPending}
            onClick={() => file.current?.click()}
          >
            <ImageUpIcon aria-hidden strokeWidth={1.75} />
            {workspace.icon_url ? t('workspaces.iconChange') : t('workspaces.iconUpload')}
          </Button>
          {workspace.icon_url && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={icon.isPending}
              onClick={() => icon.mutate(null)}
            >
              <Trash2Icon aria-hidden strokeWidth={1.75} />
              {t('workspaces.iconRemove')}
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.name}>{t('workspaces.name')}</Label>
        <Input
          id={ids.name}
          value={name}
          maxLength={80}
          required
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={ids.description}>{t('workspaces.description')}</Label>
        <textarea
          id={ids.description}
          value={description}
          maxLength={500}
          rows={2}
          className="min-h-target w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div>
        <Button type="submit" variant="outline" disabled={save.isPending || !name.trim()}>
          {t('chat.save')}
        </Button>
      </div>
    </form>
  );
}

/** The workspace's default theme preset and font template (owners and admins). */
export function WorkspaceAppearanceForm({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { preset: useId(), template: useId() };
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (a: Workspace['appearance']) => setWorkspaceAppearance(workspace.id, a),
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const a = workspace.appearance;
  return (
    <section
      aria-labelledby={`${ids.preset}-title`}
      className="grid gap-2"
      data-testid="workspace-appearance"
    >
      <h3 id={`${ids.preset}-title`} className="text-sm font-semibold">
        {t('workspaces.appearance')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('workspaces.appearanceHint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor={ids.preset}>{t('appearance.preset')}</Label>
          <select
            id={ids.preset}
            className={selectClass}
            value={a.preset}
            disabled={save.isPending}
            onChange={(e) => {
              const preset = e.target.value as typeof a.preset;
              save.mutate(
                preset === 'custom'
                  ? { ...a, preset, custom_theme: a.custom_theme ?? DEFAULT_CUSTOM_THEME }
                  : { ...a, preset },
              );
            }}
          >
            {THEME_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`appearance.presets.${p}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={ids.template}>{t('appearance.fontTemplate')}</Label>
          <select
            id={ids.template}
            className={selectClass}
            value={a.font_template}
            disabled={save.isPending}
            onChange={(e) =>
              save.mutate({ ...a, font_template: e.target.value as typeof a.font_template })
            }
          >
            {Object.keys(FONT_TEMPLATES).map((k) => (
              <option key={k} value={k}>
                {t(`appearance.templates.${k}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {a.preset === 'custom' && (
        <CustomThemeEditor
          value={a.custom_theme ?? DEFAULT_CUSTOM_THEME}
          onChange={(custom_theme) => save.mutate({ ...a, custom_theme })}
        />
      )}
    </section>
  );
}

/** Who sees the earlier versions of edited messages (owners and admins choose). */
export function EditHistorySetting({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (edit_history: 'author' | 'everyone') =>
      updateWorkspace(workspace.id, { edit_history }),
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const value = set.isPending ? set.variables : (workspace.edit_history ?? 'author');
  return (
    <fieldset className="flex flex-col gap-2 border-t pt-5">
      <legend className="text-sm font-semibold">{t('workspaces.editHistory')}</legend>
      <p className="text-xs text-muted-foreground">{t('workspaces.editHistoryHint')}</p>
      {(['author', 'everyone'] as const).map((v) => (
        <div key={v} className="flex min-h-target items-center gap-2.5 text-sm">
          <input
            id={`edit-history-${v}`}
            type="radio"
            name="edit-history"
            className="size-4"
            checked={value === v}
            onChange={() => set.mutate(v)}
          />
          <label htmlFor={`edit-history-${v}`}>
            {v === 'author'
              ? t('workspaces.editHistoryAuthor')
              : t('workspaces.editHistoryEveryone')}
          </label>
        </div>
      ))}
    </fieldset>
  );
}

const EVERY = [1, 2, 5, 10, 15, 30, 60] as const;
const TIMES = [3, 6, 10, 20] as const;

/** Whether urgent messages may remind the people they mention, how often and how many times. */
export function PersistentSetting({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const ids = { on: useId(), every: useId(), times: useId() };
  const set = useMutation({
    mutationFn: (patch: Parameters<typeof updateWorkspace>[1]) =>
      updateWorkspace(workspace.id, patch),
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const on = workspace.persistent_notifications !== false;
  const select =
    'h-8 min-h-target rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60';
  return (
    <fieldset className="flex flex-col gap-2 border-t pt-5">
      <legend className="text-sm font-semibold">{t('priority.settingTitle')}</legend>
      <p className="text-xs text-muted-foreground">{t('priority.settingHint')}</p>
      <div className="flex min-h-target items-center gap-2.5 text-sm">
        <input
          id={ids.on}
          type="checkbox"
          className="size-4"
          checked={on}
          onChange={(e) => set.mutate({ persistent_notifications: e.target.checked })}
        />
        <label htmlFor={ids.on}>{t('priority.settingOn')}</label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label htmlFor={ids.every} className="flex items-center gap-2">
          {t('priority.settingEvery')}
          <select
            id={ids.every}
            className={select}
            disabled={!on}
            value={workspace.persistent_every_minutes ?? 5}
            onChange={(e) => set.mutate({ persistent_every_minutes: Number(e.target.value) })}
          >
            {EVERY.map((m) => (
              <option key={m} value={m}>
                {t('priority.minutes', { count: m })}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.times} className="flex items-center gap-2">
          {t('priority.settingTimes')}
          <select
            id={ids.times}
            className={select}
            disabled={!on}
            value={workspace.persistent_times ?? 6}
            onChange={(e) => set.mutate({ persistent_times: Number(e.target.value) })}
          >
            {TIMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

/** Read receipts in conversations: off unless the workspace's administrators turn them on. */
export function ReadReceiptsSetting({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = useId();
  const set = useMutation({
    mutationFn: (on: boolean) => updateWorkspace(workspace.id, { read_receipts: on }),
    onSuccess: () => reloadWorkspaces(queryClient),
    onError: () => toast.error(t('channels.changeFailed')),
  });
  const on = set.isPending ? !!set.variables : !!workspace.read_receipts;
  return (
    <fieldset className="flex flex-col gap-2 border-t pt-5">
      <legend className="text-sm font-semibold">{t('receipts.settingTitle')}</legend>
      <p className="text-xs text-muted-foreground">{t('receipts.settingHint')}</p>
      <div className="flex min-h-target items-center gap-2.5 text-sm">
        <input
          id={id}
          type="checkbox"
          className="size-4"
          checked={on}
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <label htmlFor={id}>{t('receipts.settingOn')}</label>
      </div>
    </fieldset>
  );
}
