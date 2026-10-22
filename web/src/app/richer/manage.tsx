// SPDX-License-Identifier: Apache-2.0
import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon, UploadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { useSession } from '../auth/session';
import { isWorkspaceAdmin, type Workspace } from '../chat/workspaces';
import {
  addCustomEmoji,
  addSticker,
  customEmojiQuery,
  deleteCustomEmoji,
  deleteSticker,
  emojiName,
  stickersQuery,
  type CustomEmoji,
  type Sticker,
} from './richer';

type Kind = 'emoji' | 'stickers';

/** Custom emoji and stickers of a workspace: members add them; their adders and admins remove them. */
export function EmojiAndStickers({ workspace }: { workspace: Workspace }) {
  if (workspace.role === 'guest') return null;
  return (
    <>
      <PictureSet kind="emoji" workspace={workspace} />
      <PictureSet kind="stickers" workspace={workspace} />
    </>
  );
}

function PictureSet({ kind, workspace }: { kind: Kind; workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { title: useId(), name: useId() };
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const query = kind === 'emoji' ? customEmojiQuery(workspace.id) : stickersQuery(workspace.id);
  const items: (CustomEmoji | Sticker)[] = useQuery(query).data ?? [];
  const [name, setName] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
  const failed = (err: unknown) =>
    toast.error((err instanceof ApiError && err.problem.detail) || t('richer.manage.failed'));
  const add = useMutation({
    mutationFn: (file: File) =>
      kind === 'emoji'
        ? addCustomEmoji(workspace.id, emojiName(name), file)
        : addSticker(workspace.id, name.trim(), file),
    onSuccess: () => {
      setName('');
      void refresh();
      toast.success(t(`richer.manage.${kind}.added`));
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => (kind === 'emoji' ? deleteCustomEmoji(id) : deleteSticker(id)),
    onSuccess: () => void refresh(),
    onError: failed,
  });
  const valid = kind === 'emoji' ? emojiName(name).length >= 2 : name.trim().length > 0;
  const admin = isWorkspaceAdmin(workspace);
  return (
    <section aria-labelledby={ids.title} className="grid gap-2" data-testid={`manage-${kind}`}>
      <h3 id={ids.title} className="text-xs font-medium text-muted-foreground uppercase">
        {t(`richer.manage.${kind}.title`)}
      </h3>
      <p className="text-xs text-muted-foreground">{t(`richer.manage.${kind}.hint`)}</p>
      <div className="flex items-end gap-2">
        <div className="grid flex-1 gap-1">
          <Label htmlFor={ids.name}>{t(`richer.manage.${kind}.name`)}</Label>
          <Input
            id={ids.name}
            value={name}
            maxLength={kind === 'emoji' ? 32 : 40}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'emoji' ? 'party_parrot' : undefined}
          />
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) add.mutate(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!valid || add.isPending}
          onClick={() => picker.current?.click()}
        >
          <UploadIcon strokeWidth={1.75} />
          {t('richer.manage.upload')}
        </Button>
      </div>
      {kind === 'emoji' && name && (
        <p className="text-xs text-muted-foreground">
          {t('richer.manage.emoji.code', { code: `:${emojiName(name)}:` })}
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex max-h-48 flex-col overflow-y-auto">
          {items.map((it) => (
            <li key={it.id} className="flex min-h-target items-center gap-2 text-sm">
              <img
                src={it.url}
                alt=""
                className={kind === 'emoji' ? 'size-6 object-contain' : 'size-10 object-contain'}
              />
              <span className="flex-1 truncate">{kind === 'emoji' ? `:${it.name}:` : it.name}</span>
              {(admin || it.created_by === self) && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('richer.manage.remove', { name: it.name })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(it.id)}
                >
                  <Trash2Icon strokeWidth={1.75} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
