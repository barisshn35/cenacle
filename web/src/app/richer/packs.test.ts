// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { emojiName } from './richer';
import { baseName, MAX_PICTURE, packPictures, stickerName, zipName } from './packs';

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe('pack names', () => {
  it('takes names from file names', () => {
    expect(baseName('cats/party-cat.gif')).toBe('party-cat');
    expect(stickerName('party-cat__2.gif')).toBe('party cat 2');
    expect(emojiName(baseName('Party Parrot.gif'))).toBe('party_parrot');
    expect(zipName([new File([], 'Cute Cats.zip')])).toBe('Cute Cats');
    expect(zipName([new File([], 'a.gif')])).toBe('');
  });
});

describe('packPictures', () => {
  it('opens archives and keeps only usable pictures, by name', async () => {
    const zip = zipSync({
      'cats/10.gif': bytes(4),
      'cats/2.png': bytes(4),
      'cats/readme.txt': bytes(4),
      '__MACOSX/cats/._2.png': bytes(4),
      'cats/.hidden.gif': bytes(4),
    });
    const files = await packPictures([
      new File([zip as BlobPart], 'cats.zip', { type: 'application/zip' }),
      new File([bytes(4)], '1.webp', { type: 'image/webp' }),
      new File([bytes(MAX_PICTURE + 1)], 'huge.gif', { type: 'image/gif' }),
      new File([bytes(4)], 'notes.txt', { type: 'text/plain' }),
    ]);
    expect(files.map((f) => f.name)).toEqual(['1.webp', '2.png', '10.gif']);
    expect(files.map((f) => f.type)).toEqual(['image/webp', 'image/png', 'image/gif']);
  });
});
