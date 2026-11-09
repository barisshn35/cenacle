// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, RotateCcwIcon } from 'lucide-react';
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
import { useSession } from '../auth/session';
import { isWorkspaceAdmin, type Workspace } from '../chat/workspaces';
import { stickerName } from './packs';
import { addSticker, stickerPacksQuery, type Sticker } from './richer';
import {
  clampOffset,
  drawSticker,
  MAX_ZOOM,
  MIN_ZOOM,
  STICKER_SIZE,
  type Offset,
} from './sticker-art';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
/** How far an arrow key moves the picture (Shift: further). */
const STEP = 8;

type Picture = { file: File; bitmap: ImageBitmap };

/**
 * Makes a sticker from a picture: fitted into a square, zoomed and moved
 * (by dragging or with the arrow keys), with a caption above and below.
 * An animated GIF left as it is goes in unchanged, so it keeps moving.
 */
export function StickerMaker({
  open,
  onOpenChange,
  workspace,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  /** Offers "Save and send" when given. */
  onSend?: (sticker: Sticker) => void;
}) {
  const { t } = useTranslation();
  const ids = {
    name: useId(),
    top: useId(),
    bottom: useId(),
    zoom: useId(),
    pack: useId(),
    keys: useId(),
  };
  const self = useSession().user.id;
  const queryClient = useQueryClient();
  const packs = (useQuery(stickerPacksQuery(workspace.id)).data ?? []).filter(
    (p) => isWorkspaceAdmin(workspace) || p.created_by === self,
  );
  const [picture, setPicture] = useState<Picture | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [name, setName] = useState('');
  const [pack, setPack] = useState('');
  const [unreadable, setUnreadable] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; from: Offset } | null>(null);

  const reset = () => {
    setPicture(null);
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setTop('');
    setBottom('');
    setName('');
    setUnreadable(false);
    save.reset();
  };

  const choose = async (file: File | undefined) => {
    if (!file || !ACCEPT.split(',').includes(file.type)) return;
    try {
      const bitmap = await createImageBitmap(file);
      setPicture({ file, bitmap });
      setZoom(MIN_ZOOM);
      setOffset({ x: 0, y: 0 });
      setUnreadable(false);
      if (!name.trim()) setName(stickerName(file.name));
    } catch {
      setUnreadable(true);
    }
  };

  const edited =
    zoom !== MIN_ZOOM || offset.x !== 0 || offset.y !== 0 || !!top.trim() || !!bottom.trim();
  const animated = picture?.file.type === 'image/gif';

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !picture) return;
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    drawSticker(ctx, { picture: picture.bitmap, zoom, offset, top, bottom, font });
  }, [picture, zoom, offset, top, bottom]);

  const move = (next: Offset, z = zoom) => {
    if (!picture) return;
    setOffset(clampOffset(picture.bitmap.width, picture.bitmap.height, z, next));
  };

  /** The sticker's file: the picture itself when nothing changed (a GIF keeps moving), else the drawn square. */
  const output = async (): Promise<File> => {
    if (!picture) throw new Error('no picture');
    if (!edited) return picture.file;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.current?.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('no image');
    return new File([blob], 'sticker.png', { type: 'image/png' });
  };

  const save = useMutation({
    mutationFn: async (send: boolean) => {
      const s = await addSticker(workspace.id, name.trim(), await output(), pack || undefined);
      return { s, send };
    },
    onSuccess: async ({ s, send }) => {
      await queryClient.invalidateQueries({ queryKey: ['stickers', workspace.id] });
      onOpenChange(false);
      reset();
      if (send) onSend?.(s);
    },
  });

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? STEP * 4 : STEP;
    const by: Record<string, Offset> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = by[e.key];
    if (d) {
      e.preventDefault();
      move({ x: offset.x + d.x, y: offset.y + d.y });
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + (e.key === '-' ? -0.1 : 0.1)));
      setZoom(z);
      move(offset, z);
    }
  };

  /** Dragging moves the picture; the canvas shows it at a smaller size than it is made. */
  const scaleOf = (el: HTMLCanvasElement) => STICKER_SIZE / el.getBoundingClientRect().width;
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, from: offset };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const s = scaleOf(e.currentTarget);
    move({ x: d.from.x + (e.clientX - d.x) * s, y: d.from.y + (e.clientY - d.y) * s });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const valid = !!picture && !!name.trim();
  const problem =
    save.error instanceof ApiError ? save.error.problem : save.error ? { status: 500 } : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-lg"
        data-testid="sticker-maker"
      >
        <DialogHeader>
          <DialogTitle>{t('richer.maker.title')}</DialogTitle>
          <DialogDescription>{t('richer.maker.description')}</DialogDescription>
        </DialogHeader>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          hidden
          tabIndex={-1}
          aria-hidden
          data-testid="sticker-maker-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void choose(file);
          }}
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !save.isPending) save.mutate(!!onSend);
          }}
          onPaste={(e) => {
            const file = [...e.clipboardData.files].find((f) => ACCEPT.includes(f.type));
            if (file) {
              e.preventDefault();
              void choose(file);
            }
          }}
        >
          {picture ? (
            <div className="grid justify-items-center gap-2">
              <canvas
                ref={canvas}
                width={STICKER_SIZE}
                height={STICKER_SIZE}
                tabIndex={0}
                role="img"
                aria-label={t('richer.maker.preview')}
                aria-describedby={ids.keys}
                data-testid="sticker-maker-canvas"
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="size-64 max-w-full cursor-grab touch-none rounded-lg border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
              />
              <p id={ids.keys} className="text-center text-xs text-muted-foreground">
                {t('richer.maker.keys')}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => input.current?.click()}
                >
                  <ImageIcon strokeWidth={1.75} />
                  {t('richer.maker.other')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={zoom === MIN_ZOOM && offset.x === 0 && offset.y === 0}
                  onClick={() => {
                    setZoom(MIN_ZOOM);
                    setOffset({ x: 0, y: 0 });
                  }}
                >
                  <RotateCcwIcon strokeWidth={1.75} />
                  {t('richer.maker.center')}
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void choose(e.dataTransfer.files[0]);
              }}
              data-testid="sticker-maker-choose"
              className="grid min-h-40 place-items-center gap-1 rounded-lg border border-dashed p-6 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ImageIcon className="size-6" strokeWidth={1.75} />
              <span className="font-medium text-foreground">{t('richer.maker.choose')}</span>
              <span>{t('richer.maker.chooseHint')}</span>
            </button>
          )}
          {unreadable && (
            <p role="alert" className="text-sm text-destructive">
              {t('richer.maker.unreadable')}
            </p>
          )}

          {picture && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={ids.zoom}>
                  {t('richer.maker.zoom', { zoom: Math.round(zoom * 100) })}
                </Label>
                <input
                  id={ids.zoom}
                  type="range"
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => {
                    const z = Number(e.target.value);
                    setZoom(z);
                    move(offset, z);
                  }}
                  className="min-h-target accent-primary"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.top}>{t('richer.maker.top')}</Label>
                  <Input
                    id={ids.top}
                    value={top}
                    maxLength={40}
                    onChange={(e) => setTop(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.bottom}>{t('richer.maker.bottom')}</Label>
                  <Input
                    id={ids.bottom}
                    value={bottom}
                    maxLength={40}
                    onChange={(e) => setBottom(e.target.value)}
                  />
                </div>
              </div>
              {animated && (
                <p className="text-xs text-muted-foreground">
                  {edited ? t('richer.maker.stillGif') : t('richer.maker.movingGif')}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.name}>{t('richer.maker.name')}</Label>
                  <Input
                    id={ids.name}
                    value={name}
                    maxLength={40}
                    required
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                {packs.length > 0 && (
                  <div className="grid gap-1.5">
                    <Label htmlFor={ids.pack}>{t('richer.maker.pack')}</Label>
                    <select
                      id={ids.pack}
                      value={pack}
                      onChange={(e) => setPack(e.target.value)}
                      className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">{t('richer.maker.noPack')}</option>
                      {packs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}
          {problem && <InlineError problem={problem} />}
          <DialogFooter>
            {onSend && (
              <Button
                type="button"
                variant="outline"
                disabled={!valid || save.isPending}
                onClick={() => save.mutate(false)}
              >
                {t('richer.maker.save')}
              </Button>
            )}
            <Button
              type="submit"
              disabled={!valid || save.isPending}
              aria-busy={save.isPending || undefined}
            >
              {onSend ? t('richer.maker.saveAndSend') : t('richer.maker.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
