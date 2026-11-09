// SPDX-License-Identifier: AGPL-3.0-only

/** A made sticker's side in pixels; the server keeps pictures of this size as they are. */
export const STICKER_SIZE = 512;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** How much of the picture stays in the square however far it is moved. */
const KEEP = 48;

export type Offset = { x: number; y: number };

/** Where a picture of w×h lands: fitted whole at zoom 1, centred, then moved by the offset. */
export function placement(w: number, h: number, zoom: number, offset: Offset, size = STICKER_SIZE) {
  const scale = Math.min(size / w, size / h) * zoom;
  const dw = w * scale;
  const dh = h * scale;
  return { x: (size - dw) / 2 + offset.x, y: (size - dh) / 2 + offset.y, w: dw, h: dh };
}

/** An offset that keeps part of the picture in the square. */
export function clampOffset(
  w: number,
  h: number,
  zoom: number,
  offset: Offset,
  size = STICKER_SIZE,
): Offset {
  const { w: dw, h: dh } = placement(w, h, zoom, { x: 0, y: 0 }, size);
  const limit = (d: number) => Math.max(0, (d + size) / 2 - KEEP);
  const clamp = (v: number, d: number) => Math.max(-limit(d), Math.min(limit(d), v));
  return { x: clamp(offset.x, dw), y: clamp(offset.y, dh) };
}

/** Caption lines fit the square: the largest size up to a seventh of it at which the text fits. */
export function captionSize(measure: (px: number) => number, size = STICKER_SIZE): number {
  const max = Math.round(size / 7);
  const room = size * 0.92;
  for (let px = max; px > 12; px -= 2) if (measure(px) <= room) return px;
  return 12;
}

export type StickerArt = {
  picture: CanvasImageSource & { width: number; height: number };
  zoom: number;
  offset: Offset;
  top: string;
  bottom: string;
  /** The interface's typeface, so captions look like the rest of Cenacle. */
  font: string;
};

/** Draws the sticker: the picture on a clear square, captions in white with a dark edge. */
export function drawSticker(ctx: CanvasRenderingContext2D, art: StickerArt, size = STICKER_SIZE) {
  ctx.clearRect(0, 0, size, size);
  const p = placement(art.picture.width, art.picture.height, art.zoom, art.offset, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art.picture, p.x, p.y, p.w, p.h);
  drawCaption(ctx, art.top, 'top', size, size, art.font);
  drawCaption(ctx, art.bottom, 'bottom', size, size, art.font);
}

/**
 * A caption in the style of stickers and GIFs: bold white letters with a
 * black edge, as large as fits, at the top or bottom of a width × height area.
 */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  at: 'top' | 'bottom',
  width: number,
  height: number,
  family: string,
) {
  const line = text.trim();
  if (!line) return;
  const font = (px: number) => `800 ${px}px ${family}`;
  const px = captionSize(
    (n) => {
      ctx.font = font(n);
      return ctx.measureText(line).width;
    },
    Math.min(width, height * 1.4),
  );
  ctx.font = font(px);
  ctx.textAlign = 'center';
  ctx.textBaseline = at === 'top' ? 'top' : 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, px * 0.16);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  const y = at === 'top' ? height * 0.04 : height * 0.96;
  ctx.strokeText(line, width / 2, y);
  ctx.fillText(line, width / 2, y);
}
