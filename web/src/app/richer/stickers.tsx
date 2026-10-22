// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { StickerIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@cenacle/ui/components/popover';
import { useActiveWorkspace } from '../chat/active-workspace';
import { stickersQuery, type Sticker } from './richer';

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

/** The composer's sticker button: picking one sends it. */
export function StickerPicker({ onPick }: { onPick: (sticker: Sticker) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ws = useActiveWorkspace().id;
  const stickers = useQuery(stickersQuery(ws)).data ?? [];
  if (stickers.length === 0) return null;
  return (
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
        <PopoverTitle className="mb-2 text-sm font-medium">
          {t('richer.stickers.title')}
        </PopoverTitle>
        <ul className="grid max-h-72 grid-cols-4 gap-1 overflow-y-auto" data-testid="sticker-list">
          {stickers.map((s) => (
            <li key={s.id}>
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
                <img src={s.url} alt="" loading="lazy" className="size-full object-contain" />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
