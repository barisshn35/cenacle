// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilmIcon, ImagePlusIcon, PlusIcon, StarIcon, StickerIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { cn } from '@cenacle/ui/lib/utils';
import { useActiveWorkspace } from '../chat/active-workspace';
import { GifMaker } from './gif-maker';
import { gifError, useSaveSticker } from './keep';
import { stickerName } from './packs';
import {
  addGif,
  deleteGif,
  gifFile,
  MAX_GIF,
  MAX_GIFS,
  myGifsQuery,
  stickerPacksQuery,
  stickersQuery,
  type Sticker,
  type UserGif,
} from './richer';
import { StickerMaker } from './sticker-maker';

/** A sticker in a message: a larger picture, named for screen readers. */
export function StickerImage({ sticker }: { sticker: Pick<Sticker, 'name' | 'url'> }) {
  return (
    <img
      data-testid="sticker"
      src={sticker.url}
      alt={sticker.name}
      title={sticker.name}
      loading="lazy"
      decoding="async"
      className="mt-1 size-32 object-contain"
    />
  );
}

/** A secondary button on a tile: shown on hover and focus, always on touch screens. */
function TileAction({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'absolute end-0 top-0 flex size-6 pointer-coarse:size-11 items-center justify-center rounded-md bg-popover/90 text-muted-foreground shadow-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:opacity-100',
        pressed
          ? 'text-foreground opacity-100'
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
      )}
    >
      {children}
    </button>
  );
}

type Tab = 'stickers' | 'gifs';

/**
 * The composer's sticker and GIF button. Picking a sticker sends it; saved
 * stickers come first, then packs. Members (not guests) also make their own.
 * With `onGif` (the person may attach files), one's own GIFs are a tab: one
 * picked goes into the message, and new ones are added or made from a video.
 */
export function StickerPicker({
  onPick,
  onGif,
}: {
  onPick: (sticker: Sticker) => void;
  onGif?: (file: File) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('stickers');
  const [making, setMaking] = useState<'sticker' | 'gif' | null>(null);
  const { id: ws, workspace } = useActiveWorkspace();
  const stickers = useQuery(stickersQuery(ws)).data ?? [];
  const packs = useQuery(stickerPacksQuery(ws)).data ?? [];
  const saveSticker = useSaveSticker(ws);
  const mayMake = !!workspace && workspace.role !== 'guest';
  if (stickers.length === 0 && !mayMake && !onGif) return null;
  const tabs: Tab[] = onGif ? ['stickers', 'gifs'] : ['stickers'];
  const current = onGif ? tab : 'stickers';

  const saved = stickers.filter((s) => s.saved);
  const sections = [
    { id: 'saved', name: t('richer.stickers.savedSection'), items: saved },
    ...packs.map((p) => ({
      id: p.id,
      name: p.name,
      items: stickers.filter((s) => s.pack_id === p.id),
    })),
    {
      id: 'loose',
      name: packs.length > 0 || saved.length > 0 ? t('richer.stickers.other') : '',
      items: stickers.filter((s) => !s.pack_id || !packs.some((p) => p.id === s.pack_id)),
    },
  ].filter((section) => section.items.length > 0);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(current) + 1) % tabs.length]!;
    setTab(next);
    e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('richer.stickers.open')}
            />
          }
        >
          <StickerIcon strokeWidth={1.75} />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-80">
          {tabs.length > 1 ? (
            <div
              role="tablist"
              aria-label={t('richer.stickers.open')}
              className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-0.5"
            >
              {tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  data-tab={id}
                  id={`sticker-tab-${id}`}
                  aria-selected={current === id}
                  aria-controls={`sticker-panel-${id}`}
                  tabIndex={current === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  onKeyDown={onTabKey}
                  className="min-h-target rounded-md text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 aria-selected:bg-popover aria-selected:text-foreground aria-selected:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {id === 'stickers' ? t('richer.stickers.title') : t('richer.gifs.title')}
                </button>
              ))}
            </div>
          ) : (
            <PopoverTitle className="mb-2 text-sm font-medium">
              {t('richer.stickers.title')}
            </PopoverTitle>
          )}
          {current === 'stickers' ? (
            <div
              role={tabs.length > 1 ? 'tabpanel' : undefined}
              id="sticker-panel-stickers"
              aria-labelledby={tabs.length > 1 ? 'sticker-tab-stickers' : undefined}
            >
              <div className="grid max-h-80 gap-3 overflow-y-auto" data-testid="sticker-list">
                {sections.map((section) => (
                  <section
                    key={section.id}
                    aria-label={section.name || undefined}
                    className="grid gap-1"
                  >
                    {section.name && (
                      <h4 className="sticky top-0 z-10 bg-popover py-0.5 text-xs font-medium text-muted-foreground">
                        {section.name}
                      </h4>
                    )}
                    <ul className="grid grid-cols-4 gap-1 pointer-coarse:grid-cols-3">
                      {section.items.map((s) => (
                        <li key={s.id} className="group relative">
                          <button
                            type="button"
                            aria-label={s.name}
                            title={s.name}
                            onClick={() => {
                              setOpen(false);
                              onPick(s);
                            }}
                            className="flex aspect-square w-full items-center justify-center rounded-md p-1 outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <img
                              src={s.url}
                              alt=""
                              loading="lazy"
                              className="size-full object-contain"
                            />
                          </button>
                          <TileAction
                            label={t(s.saved ? 'richer.stickers.unsave' : 'richer.stickers.save', {
                              name: s.name,
                            })}
                            pressed={!!s.saved}
                            onClick={() => saveSticker.mutate({ id: s.id, saved: !s.saved })}
                          >
                            <StarIcon
                              className={cn('size-3.5', s.saved && 'fill-current')}
                              strokeWidth={1.75}
                            />
                          </TileAction>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                {sections.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {t('richer.stickers.none')}
                  </p>
                )}
              </div>
              {mayMake && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  data-testid="sticker-make"
                  onClick={() => {
                    setOpen(false);
                    setMaking('sticker');
                  }}
                >
                  <PlusIcon strokeWidth={1.75} />
                  {t('richer.stickers.make')}
                </Button>
              )}
            </div>
          ) : (
            <GifPanel
              onPick={(file) => {
                setOpen(false);
                onGif?.(file);
              }}
              onMake={() => {
                setOpen(false);
                setMaking('gif');
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      {workspace && mayMake && (
        <StickerMaker
          open={making === 'sticker'}
          onOpenChange={(o) => setMaking(o ? 'sticker' : null)}
          workspace={workspace}
          onSend={onPick}
        />
      )}
      {onGif && (
        <GifMaker
          open={making === 'gif'}
          onOpenChange={(o) => setMaking(o ? 'gif' : null)}
          onSend={onGif}
        />
      )}
    </>
  );
}

/** One's own GIFs: picking one attaches it; new ones come from a file or a video. */
function GifPanel({ onPick, onMake }: { onPick: (file: File) => void; onMake: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const gifs = useQuery(myGifsQuery);
  const list = gifs.data ?? [];
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: myGifsQuery.queryKey });

  const add = useMutation({
    mutationFn: (file: File) => addGif(stickerName(file.name) || 'GIF', file),
    onSuccess: () => {
      void refresh();
      toast.success(t('richer.gifs.added'));
    },
    onError: (err) => toast.error(gifError(err, t)),
  });
  const pick = useMutation({
    mutationFn: gifFile,
    onSuccess: onPick,
    onError: () => toast.error(t('richer.gifs.openFailed')),
  });
  const remove = useMutation({
    mutationFn: async (gif: UserGif) => {
      // Kept, so that it can come back.
      const file = await gifFile(gif);
      await deleteGif(gif.id);
      return { gif, file };
    },
    onSuccess: ({ gif, file }) => {
      void refresh();
      showUndoToast({
        message: t('richer.gifs.removed', { name: gif.name }),
        onUndo: async () => {
          await addGif(gif.name, file);
          await refresh();
        },
      });
    },
    onError: () => toast.error(t('richer.gifs.removeFailed')),
  });

  return (
    <div role="tabpanel" id="sticker-panel-gifs" aria-labelledby="sticker-tab-gifs">
      <input
        ref={input}
        type="file"
        accept="image/gif"
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="gif-add-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.type !== 'image/gif') toast.error(t('richer.gifs.notGif'));
          else if (file.size > MAX_GIF) toast.error(t('richer.gifs.tooLarge'));
          else add.mutate(file);
        }}
      />
      <ul className="grid max-h-80 grid-cols-2 gap-1 overflow-y-auto" data-testid="gif-list">
        {list.map((g) => (
          <li key={g.id} className="group relative">
            <button
              type="button"
              aria-label={g.name}
              title={g.name}
              disabled={pick.isPending}
              onClick={() => pick.mutate(g)}
              className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted outline-none hover:ring-2 hover:ring-ring/40 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <img
                src={g.url}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
            </button>
            <TileAction
              label={t('richer.gifs.remove', { name: g.name })}
              onClick={() => remove.mutate(g)}
            >
              <XIcon className="size-3.5" strokeWidth={1.75} />
            </TileAction>
          </li>
        ))}
      </ul>
      {gifs.isSuccess && list.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('richer.gifs.none')}</p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <Button type="button" variant="outline" size="sm" data-testid="gif-make" onClick={onMake}>
          <FilmIcon strokeWidth={1.75} />
          {t('richer.gifs.make')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={add.isPending || list.length >= MAX_GIFS}
          onClick={() => input.current?.click()}
        >
          <ImagePlusIcon strokeWidth={1.75} />
          {t('richer.gifs.add')}
        </Button>
      </div>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        {t('richer.gifs.count', { count: list.length, max: MAX_GIFS })}
      </p>
    </div>
  );
}
