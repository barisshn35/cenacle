// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FilmIcon, RotateCcwIcon } from 'lucide-react';
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
import { formatSize } from '../chat/files';
import {
  encodeGif,
  frameTimes,
  GIF_FPS,
  GIF_WIDTHS,
  gifSize,
  MAX_SECONDS,
  MIN_SECONDS,
} from './gif-art';
import { stickerName } from './packs';
import { addGif, MAX_GIF, myGifsQuery } from './richer';
import { drawCaption } from './sticker-art';

type Video = { file: File; url: string; width: number; height: number; duration: number };
type Result = { blob: Blob; url: string };

/** Waits for a video element's event, or fails on its error. */
const once = (el: HTMLVideoElement, event: 'loadeddata' | 'seeked') =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      el.removeEventListener(event, done);
      el.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      el.removeEventListener(event, done);
      reject(new Error('video'));
    };
    el.addEventListener(event, done);
    el.addEventListener('error', fail, { once: true });
  });

const seconds = (s: number) => (Math.round(s * 10) / 10).toFixed(1);

/**
 * Makes a GIF from a part of a video, in the browser: where it starts, how
 * long it is (up to ten seconds), its width and frame rate, and a caption
 * above and below. The GIF is kept among one's own and/or sent at once.
 */
export function GifMaker({
  open,
  onOpenChange,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Offers "Send" when given: the GIF goes into the message being written. */
  onSend?: (file: File) => void;
}) {
  const { t, i18n } = useTranslation();
  const ids = {
    start: useId(),
    length: useId(),
    width: useId(),
    fps: useId(),
    top: useId(),
    bottom: useId(),
    name: useId(),
  };
  const queryClient = useQueryClient();
  const [video, setVideo] = useState<Video | null>(null);
  const [start, setStart] = useState(0);
  const [length, setLength] = useState(3);
  const [width, setWidth] = useState<number>(320);
  const [fps, setFps] = useState<number>(15);
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [name, setName] = useState('');
  const [unreadable, setUnreadable] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const making = useRef<AbortController | null>(null);

  // Object URLs are let go of when they are replaced or the maker closes.
  useEffect(() => {
    if (video) return () => URL.revokeObjectURL(video.url);
  }, [video]);
  useEffect(() => {
    if (result) return () => URL.revokeObjectURL(result.url);
  }, [result]);

  const reset = () => {
    making.current?.abort();
    setVideo(null);
    setResult(null);
    setProgress(null);
    setStart(0);
    setLength(3);
    setTop('');
    setBottom('');
    setName('');
    setUnreadable(false);
    save.reset();
  };

  const choose = async (file: File | undefined) => {
    if (!file || !file.type.startsWith('video/')) return;
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.src = url;
    try {
      await once(el, 'loadeddata');
      if (!el.videoWidth || !Number.isFinite(el.duration)) throw new Error('video');
      setVideo({ file, url, width: el.videoWidth, height: el.videoHeight, duration: el.duration });
      setStart(0);
      setLength(Math.min(3, el.duration));
      setResult(null);
      setUnreadable(false);
      if (!name.trim()) setName(stickerName(file.name));
    } catch {
      URL.revokeObjectURL(url);
      setUnreadable(true);
    }
  };

  // The preview plays the chosen part over and over.
  const end = video ? Math.min(start + length, video.duration) : 0;
  useEffect(() => {
    const el = preview.current;
    if (!el || !video) return;
    el.currentTime = start;
    const loop = () => {
      if (el.currentTime >= end || el.currentTime < start) el.currentTime = start;
    };
    el.addEventListener('timeupdate', loop);
    return () => el.removeEventListener('timeupdate', loop);
  }, [video, start, end]);

  const make = async () => {
    if (!video) return;
    const stop = new AbortController();
    making.current = stop;
    setProgress(0);
    setResult(null);
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.src = video.url;
    try {
      await once(el, 'loadeddata');
      const { w, h } = gifSize(video.width, video.height, width);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      const times = frameTimes(start, length, fps, video.duration);
      const bytes = await encodeGif({
        count: times.length,
        width: w,
        height: h,
        fps,
        signal: stop.signal,
        onProgress: setProgress,
        frame: async (i) => {
          el.currentTime = times[i]!;
          await once(el, 'seeked');
          ctx.drawImage(el, 0, 0, w, h);
          drawCaption(ctx, top, 'top', w, h, font);
          drawCaption(ctx, bottom, 'bottom', w, h, font);
          return ctx.getImageData(0, 0, w, h).data;
        },
      });
      const blob = new Blob([bytes as BlobPart], { type: 'image/gif' });
      setResult({ blob, url: URL.createObjectURL(blob) });
    } catch {
      if (!stop.signal.aborted) setUnreadable(true);
    } finally {
      el.removeAttribute('src');
      el.load();
      if (making.current === stop) making.current = null;
      setProgress(null);
    }
  };

  const fileOf = (r: Result) =>
    new File([r.blob], `${name.trim() || 'gif'}.gif`, { type: 'image/gif' });

  const save = useMutation({
    mutationFn: async () => {
      if (!result) throw new Error('no gif');
      await addGif(name.trim(), result.blob);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myGifsQuery.queryKey });
      onOpenChange(false);
      reset();
    },
  });

  const tooLarge = !!result && result.blob.size > MAX_GIF;
  const busy = progress !== null;
  const problem =
    save.error instanceof ApiError
      ? save.error.problem.code === 'gif_limit'
        ? { title: t('richer.gifs.limit') }
        : { problem: save.error.problem }
      : save.error
        ? { problem: { status: 500 } }
        : null;
  const changed = () => setResult(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" data-testid="gif-maker">
        <DialogHeader>
          <DialogTitle>{t('richer.gifMaker.title')}</DialogTitle>
          <DialogDescription>{t('richer.gifMaker.description')}</DialogDescription>
        </DialogHeader>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          tabIndex={-1}
          aria-hidden
          data-testid="gif-maker-file"
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
            if (!result) void make();
          }}
        >
          {!video ? (
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void choose(e.dataTransfer.files[0]);
              }}
              data-testid="gif-maker-choose"
              className="grid min-h-40 place-items-center gap-1 rounded-lg border border-dashed p-6 text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <FilmIcon className="size-6" strokeWidth={1.75} />
              <span className="font-medium text-foreground">{t('richer.gifMaker.choose')}</span>
              <span>{t('richer.gifMaker.chooseHint')}</span>
            </button>
          ) : result ? (
            <div className="grid justify-items-center gap-2">
              <img
                src={result.url}
                alt={t('richer.gifMaker.result')}
                data-testid="gif-maker-result"
                className="max-h-64 max-w-full rounded-lg border"
              />
              <p className="text-xs text-muted-foreground" data-testid="gif-maker-size">
                {formatSize(result.blob.size, i18n.language)}
              </p>
              {tooLarge && (
                <p role="alert" className="text-center text-sm text-destructive">
                  {t('richer.gifMaker.tooLarge', { size: formatSize(MAX_GIF, i18n.language) })}
                </p>
              )}
              <Button type="button" variant="outline" size="sm" onClick={changed}>
                <RotateCcwIcon strokeWidth={1.75} />
                {t('richer.gifMaker.again')}
              </Button>
            </div>
          ) : (
            <div className="relative grid justify-items-center">
              <video
                ref={preview}
                src={video.url}
                muted
                autoPlay
                playsInline
                aria-label={t('richer.gifMaker.preview')}
                className="max-h-64 max-w-full rounded-lg border bg-black"
              />
              {[top, bottom].map((text, i) =>
                text.trim() ? (
                  <span
                    key={i}
                    aria-hidden
                    className={`pointer-events-none absolute inset-x-2 text-center text-xl font-extrabold text-white [paint-order:stroke] [-webkit-text-stroke:4px_black] ${i ? 'bottom-2' : 'top-2'}`}
                  >
                    {text}
                  </span>
                ) : null,
              )}
            </div>
          )}
          {unreadable && (
            <p role="alert" className="text-sm text-destructive">
              {t('richer.gifMaker.unreadable')}
            </p>
          )}

          {video && !result && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.start}>
                    {t('richer.gifMaker.start', { seconds: seconds(start) })}
                  </Label>
                  <input
                    id={ids.start}
                    type="range"
                    min={0}
                    max={Math.max(0, video.duration - MIN_SECONDS)}
                    step={0.1}
                    value={start}
                    disabled={busy}
                    onChange={(e) => setStart(Number(e.target.value))}
                    className="min-h-target accent-primary"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.length}>
                    {t('richer.gifMaker.length', { seconds: seconds(end - start) })}
                  </Label>
                  <input
                    id={ids.length}
                    type="range"
                    min={MIN_SECONDS}
                    max={Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, video.duration))}
                    step={0.1}
                    value={length}
                    disabled={busy}
                    onChange={(e) => setLength(Number(e.target.value))}
                    className="min-h-target accent-primary"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.width}>{t('richer.gifMaker.width')}</Label>
                  <select
                    id={ids.width}
                    value={width}
                    disabled={busy}
                    onChange={(e) => setWidth(Number(e.target.value))}
                    className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {GIF_WIDTHS.map((w) => (
                      <option key={w} value={w}>
                        {t('richer.gifMaker.pixels', { count: w })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.fps}>{t('richer.gifMaker.fps')}</Label>
                  <select
                    id={ids.fps}
                    value={fps}
                    disabled={busy}
                    onChange={(e) => setFps(Number(e.target.value))}
                    className="min-h-target h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {GIF_FPS.map((f) => (
                      <option key={f} value={f}>
                        {t('richer.gifMaker.perSecond', { count: f })}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.top}>{t('richer.maker.top')}</Label>
                  <Input
                    id={ids.top}
                    value={top}
                    maxLength={40}
                    disabled={busy}
                    onChange={(e) => setTop(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.bottom}>{t('richer.maker.bottom')}</Label>
                  <Input
                    id={ids.bottom}
                    value={bottom}
                    maxLength={40}
                    disabled={busy}
                    onChange={(e) => setBottom(e.target.value)}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <FilmIcon strokeWidth={1.75} />
                {t('richer.gifMaker.other')}
              </Button>
            </>
          )}

          {result && (
            <div className="grid gap-1.5">
              <Label htmlFor={ids.name}>{t('richer.gifMaker.name')}</Label>
              <Input
                id={ids.name}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          {busy && (
            <div className="grid gap-1.5" role="status">
              <span className="text-sm">
                {t('richer.gifMaker.making', { percent: Math.round((progress ?? 0) * 100) })}
              </span>
              <progress
                value={progress ?? 0}
                max={1}
                className="h-2 w-full accent-primary"
                aria-label={t('richer.gifMaker.progress')}
              />
            </div>
          )}
          {problem && <InlineError {...problem} />}
          <DialogFooter>
            {busy ? (
              <Button type="button" variant="outline" onClick={() => making.current?.abort()}>
                {t('richer.gifMaker.cancel')}
              </Button>
            ) : result ? (
              <>
                {onSend && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() => {
                      onSend(fileOf(result));
                      onOpenChange(false);
                      reset();
                    }}
                  >
                    {t('richer.gifMaker.send')}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={tooLarge || !name.trim() || save.isPending}
                  aria-busy={save.isPending || undefined}
                  onClick={() => save.mutate()}
                >
                  {t('richer.gifMaker.keep')}
                </Button>
              </>
            ) : (
              <Button type="submit" disabled={!video}>
                {t('richer.gifMaker.make')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
