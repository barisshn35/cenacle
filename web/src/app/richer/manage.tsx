// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { useSession } from '../auth/session';
import { isWorkspaceAdmin, may, type Workspace } from '../chat/workspaces';
import { baseName, packPictures, stickerName, zipName } from './packs';
import { StickerMaker } from './sticker-maker';
import {
  addCustomEmoji,
  addSticker,
  createStickerPack,
  customEmojiQuery,
  deleteCustomEmoji,
  deleteSticker,
  deleteStickerPack,
  emojiName,
  stickerPacksQuery,
  stickersQuery,
  type Sticker,
  type StickerPack,
} from './richer';

/** What the file pickers take: pictures, and .zip packs of them. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.zip,application/zip';

/** Custom emoji and sticker packs of a workspace: whom the scheme lets add them; their adders and admins remove them. */
export function EmojiAndStickers({ workspace }: { workspace: Workspace }) {
  const emoji = may(workspace, 'custom_emoji');
  const stickers = workspace.role !== 'guest';
  if (!emoji && !stickers) return null;
  return (
    <>
      {emoji && <EmojiSet workspace={workspace} />}
      {stickers && <StickerPacks workspace={workspace} />}
    </>
  );
}

type Progress = { done: number; total: number } | null;

/**
 * Uploads one by one (the server checks each picture), saying how far it is;
 * stops at the workspace's limit. Returns how many went in and which did not.
 */
function useBatch() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<Progress>(null);
  const run = async <T,>(items: T[], one: (item: T) => Promise<unknown>) => {
    let ok = 0;
    let failed = 0;
    let detail: string | undefined;
    setProgress({ done: 0, total: items.length });
    for (const [i, item] of items.entries()) {
      try {
        await one(item);
        ok++;
      } catch (err) {
        failed++;
        if (err instanceof ApiError) detail = err.problem.detail;
        if (err instanceof ApiError && err.problem.code === 'emoji_limit') {
          failed += items.length - i - 1;
          break;
        }
      }
      setProgress({ done: i + 1, total: items.length });
    }
    setProgress(null);
    return { ok, failed, detail };
  };
  const status = progress && (
    <p role="status" className="text-xs text-muted-foreground tabular-nums">
      {t('richer.manage.uploading', progress)}
    </p>
  );
  const report = (r: { ok: number; failed: number; detail?: string }, added: string) => {
    if (r.failed === 0) toast.success(t(added, { count: r.ok }));
    else if (r.ok === 0) toast.error(r.detail || t('richer.manage.failed'));
    else toast.warning(t('richer.manage.partial', { ok: r.ok, failed: r.failed }));
  };
  return { run, busy: progress !== null, status, report };
}

/** A hidden file picker of pictures and .zip packs; open() shows it. */
function useFilePicker(onFiles: (files: File[]) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = '';
        if (files.length > 0) onFiles(files);
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

function EmojiSet({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { title: useId(), name: useId(), hint: useId() };
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const query = customEmojiQuery(workspace.id);
  const items = useQuery(query).data ?? [];
  const [name, setName] = useState('');
  const batch = useBatch();
  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
  const add = async (chosen: File[]) => {
    const pictures = await packPictures(chosen).catch(() => []);
    if (pictures.length === 0) {
      toast.error(t('richer.manage.noPictures'));
      return;
    }
    // One picture takes the typed name; more are named after their files.
    const typed = emojiName(name);
    const named = pictures.map((file) => ({
      file,
      name: pictures.length === 1 && typed.length >= 2 ? typed : emojiName(baseName(file.name)),
    }));
    const r = await batch.run(named, (e) =>
      e.name.length < 2
        ? Promise.reject(new Error('name'))
        : addCustomEmoji(workspace.id, e.name, e.file),
    );
    if (r.ok > 0) setName('');
    void refresh();
    batch.report(r, 'richer.manage.emoji.added');
  };
  const picker = useFilePicker((files) => void add(files));
  const remove = useMutation({
    mutationFn: deleteCustomEmoji,
    onSuccess: () => void refresh(),
    onError: (err: unknown) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('richer.manage.failed')),
  });
  const admin = isWorkspaceAdmin(workspace);
  return (
    <section aria-labelledby={ids.title} className="grid gap-2" data-testid="manage-emoji">
      <h3 id={ids.title} className="text-sm font-semibold">
        {t('richer.manage.emoji.title')}
      </h3>
      <p id={ids.hint} className="text-xs text-muted-foreground">
        {t('richer.manage.emoji.hint')}
      </p>
      <div className="flex items-end gap-2">
        <div className="grid flex-1 gap-1">
          <Label htmlFor={ids.name}>{t('richer.manage.emoji.name')}</Label>
          <Input
            id={ids.name}
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="party_parrot"
            aria-describedby={ids.hint}
          />
        </div>
        {picker.input}
        <Button type="button" variant="outline" disabled={batch.busy} onClick={picker.open}>
          <UploadIcon strokeWidth={1.75} />
          {t('richer.manage.upload')}
        </Button>
      </div>
      {name && (
        <p className="text-xs text-muted-foreground">
          {t('richer.manage.emoji.code', { code: `:${emojiName(name)}:` })}
        </p>
      )}
      {batch.status}
      {items.length > 0 && (
        <ul className="flex max-h-48 flex-col overflow-y-auto">
          {items.map((it) => (
            <li key={it.id} className="flex min-h-target items-center gap-2 text-sm">
              <img src={it.url} alt="" className="size-6 object-contain" />
              <span className="flex-1 truncate">{`:${it.name}:`}</span>
              {(admin || it.created_by === self) && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('richer.manage.remove', { name: `:${it.name}:` })}
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

function StickerPacks({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const ids = { title: useId(), name: useId(), hint: useId() };
  const queryClient = useQueryClient();
  const packs = useQuery(stickerPacksQuery(workspace.id)).data ?? [];
  const stickers = useQuery(stickersQuery(workspace.id)).data ?? [];
  const [name, setName] = useState('');
  const [making, setMaking] = useState(false);
  const batch = useBatch();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['stickers', workspace.id] });

  /** Puts the chosen pictures into a pack: a new one, or one already there. */
  const fill = async (chosen: File[], into?: StickerPack) => {
    const pictures = await packPictures(chosen).catch(() => []);
    if (pictures.length === 0) {
      toast.error(t('richer.manage.noPictures'));
      return;
    }
    let pack = into;
    if (!pack) {
      try {
        pack = await createStickerPack(
          workspace.id,
          name.trim() || zipName(chosen) || t('richer.manage.packs.untitled'),
        );
      } catch (err) {
        toast.error((err instanceof ApiError && err.problem.detail) || t('richer.manage.failed'));
        return;
      }
      setName('');
    }
    const id = pack.id;
    const r = await batch.run(pictures, (file) =>
      addSticker(workspace.id, stickerName(file.name) || pack.name, file, id),
    );
    void refresh();
    batch.report(r, 'richer.manage.packs.added');
  };
  const picker = useFilePicker((files) => void fill(files));

  const loose = stickers.filter((s) => !s.pack_id);
  return (
    <section aria-labelledby={ids.title} className="grid gap-3" data-testid="manage-stickers">
      <div className="grid gap-2">
        <h3 id={ids.title} className="text-sm font-semibold">
          {t('richer.manage.packs.title')}
        </h3>
        <p id={ids.hint} className="text-xs text-muted-foreground">
          {t('richer.manage.packs.hint')}
        </p>
        <div className="flex items-end gap-2">
          <div className="grid flex-1 gap-1">
            <Label htmlFor={ids.name}>{t('richer.manage.packs.name')}</Label>
            <Input
              id={ids.name}
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              aria-describedby={ids.hint}
            />
          </div>
          {picker.input}
          <Button type="button" variant="outline" disabled={batch.busy} onClick={picker.open}>
            <UploadIcon strokeWidth={1.75} />
            {t('richer.manage.packs.upload')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setMaking(true)}>
            <PlusIcon strokeWidth={1.75} />
            {t('richer.stickers.make')}
          </Button>
        </div>
        {batch.status}
        <StickerMaker open={making} onOpenChange={setMaking} workspace={workspace} />
      </div>
      {packs.map((pack) => (
        <PackGroup
          key={pack.id}
          workspace={workspace}
          pack={pack}
          stickers={stickers.filter((s) => s.pack_id === pack.id)}
          busy={batch.busy}
          onAdd={(files) => void fill(files, pack)}
          onChanged={refresh}
        />
      ))}
      {loose.length > 0 && (
        <PackGroup workspace={workspace} stickers={loose} busy={batch.busy} onChanged={refresh} />
      )}
    </section>
  );
}

/** A pack's stickers (or those in none), with its tools for who may change it. */
function PackGroup({
  workspace,
  pack,
  stickers,
  busy,
  onAdd,
  onChanged,
}: {
  workspace: Workspace;
  pack?: StickerPack;
  stickers: Sticker[];
  busy: boolean;
  onAdd?: (files: File[]) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const self = useSession().user.id;
  const admin = isWorkspaceAdmin(workspace);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const picker = useFilePicker((files) => onAdd?.(files));
  const mayChange = pack ? admin || pack.created_by === self : true;
  const mayRemove = (s: Sticker) => admin || s.created_by === self;
  const remove = useMutation({
    mutationFn: deleteSticker,
    onSuccess: onChanged,
    onError: (err: unknown) =>
      toast.error((err instanceof ApiError && err.problem.detail) || t('richer.manage.failed')),
  });
  const title = pack?.name ?? t('richer.manage.packs.loose');
  const editable = pack ? mayChange : stickers.some(mayRemove);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="grid gap-2 rounded-lg border p-3"
      data-testid="sticker-pack"
    >
      <div className="flex items-center gap-2">
        <p id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">
          {title}
          <span className="ms-2 font-normal text-muted-foreground tabular-nums">
            {t('richer.manage.packs.count', { count: stickers.length })}
          </span>
        </p>
        {pack && mayChange && (
          <>
            {picker.input}
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label={t('richer.manage.packs.addTo', { name: pack.name })}
              onClick={picker.open}
            >
              <PlusIcon strokeWidth={1.75} />
            </Button>
          </>
        )}
        {editable && stickers.length > 0 && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-pressed={editing}
            aria-label={t('richer.manage.packs.edit', { name: title })}
            onClick={() => setEditing((e) => !e)}
          >
            <PencilIcon strokeWidth={1.75} />
          </Button>
        )}
        {pack && mayChange && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('richer.manage.packs.remove', { name: pack.name })}
            onClick={() => setConfirm(true)}
          >
            <Trash2Icon strokeWidth={1.75} />
          </Button>
        )}
      </div>
      {stickers.length > 0 ? (
        <ul className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
          {stickers.map((s) => (
            <li key={s.id} className="relative">
              <img
                src={s.url}
                alt={s.name}
                title={s.name}
                loading="lazy"
                className="size-14 rounded-md object-contain"
              />
              {editing && mayRemove(s) && (
                <Button
                  size="icon-xs"
                  variant="secondary"
                  className="absolute -end-1 -top-1 rounded-full shadow-sm"
                  aria-label={t('richer.manage.remove', { name: s.name })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(s.id)}
                >
                  <XIcon strokeWidth={1.75} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('richer.manage.packs.empty')}</p>
      )}
      {pack && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          severity="s2"
          irreversible
          title={t('richer.manage.packs.removeTitle', { name: pack.name })}
          description={t('richer.manage.packs.removeHint', { count: stickers.length })}
          confirmLabel={t('richer.manage.packs.removeConfirm')}
          onConfirm={async () => {
            await deleteStickerPack(pack.id);
            onChanged();
            setConfirm(false);
          }}
        />
      )}
    </div>
  );
}
