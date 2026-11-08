// SPDX-License-Identifier: AGPL-3.0-only

/** What a pack may hold: the pictures the server takes. */
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
/** The server's limit for one picture. */
export const MAX_PICTURE = 5 << 20;
/** At most this many pictures are taken from what was chosen at once. */
export const MAX_FILES = 200;

const isZip = (f: File) => f.type === 'application/zip' || /\.zip$/i.test(f.name);

/** A file's name without its folders and extension. */
export const baseName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '');

/** A sticker's name from its file's: "party-cat_2.gif" → "party cat 2". */
export const stickerName = (fileName: string) =>
  baseName(fileName).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * The pictures among chosen files, with .zip files opened (in the browser):
 * folders and other files inside are skipped, as are pictures too large for
 * the server. Sorted by name, as a pack is usually numbered.
 */
export async function packPictures(files: Iterable<File>): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (isZip(file)) out.push(...(await unzipPictures(file)));
    else if (PICTURE.test(file.name) || file.type.startsWith('image/')) out.push(file);
  }
  return out
    .filter((f) => f.size <= MAX_PICTURE)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .slice(0, MAX_FILES);
}

async function unzipPictures(zip: File): Promise<File[]> {
  const { unzip } = await import('fflate');
  const data = new Uint8Array(await zip.arrayBuffer());
  let taken = 0;
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      data,
      {
        // Only pictures, within the limits, are inflated at all.
        filter: (f) =>
          PICTURE.test(f.name) &&
          !f.name.startsWith('__MACOSX/') &&
          !baseName(f.name).startsWith('.') &&
          f.originalSize <= MAX_PICTURE &&
          taken++ < MAX_FILES,
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  );
  return Object.entries(entries).map(([name, bytes]) => {
    const ext = name.split('.').pop()!.toLowerCase();
    return new File([bytes as BlobPart], baseName(name) + '.' + ext, { type: TYPES[ext] });
  });
}

/** The name of a pack made from a single .zip: the archive's own name. */
export const zipName = (files: Iterable<File>) => {
  const list = [...files];
  return list.length === 1 && isZip(list[0]!) ? stickerName(list[0]!.name) : '';
};
