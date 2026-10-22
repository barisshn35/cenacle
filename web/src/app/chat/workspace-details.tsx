// SPDX-License-Identifier: Apache-2.0
import { useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageUpIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { initials } from '../auth/sign-out';
import {
  deleteWorkspaceIcon,
  reloadWorkspaces,
  setWorkspaceIcon,
  updateWorkspace,
  type Workspace,
} from './workspaces';

const MAX_UPLOAD = 5 * 1024 * 1024;

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
