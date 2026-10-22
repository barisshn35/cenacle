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
import { FONT_TEMPLATES, THEME_PRESETS } from '@cenacle/ui/theme';
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
      <h3
        id={`${ids.preset}-title`}
        className="text-xs font-medium text-muted-foreground uppercase"
      >
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
            onChange={(e) => save.mutate({ ...a, preset: e.target.value as typeof a.preset })}
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
    </section>
  );
}
