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
import { stickerPacksQuery, stickersQuery, type Sticker } from './richer';

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

/** The composer's sticker button: picking one sends it. Packs show as sections. */
export function StickerPicker({ onPick }: { onPick: (sticker: Sticker) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ws = useActiveWorkspace().id;
  const stickers = useQuery(stickersQuery(ws)).data ?? [];
  const packs = useQuery(stickerPacksQuery(ws)).data ?? [];
  if (stickers.length === 0) return null;
  const sections = [
    ...packs.map((p) => ({
      id: p.id,
      name: p.name,
      items: stickers.filter((s) => s.pack_id === p.id),
    })),
    {
      id: 'loose',
      name: packs.length > 0 ? t('richer.stickers.other') : '',
      items: stickers.filter((s) => !s.pack_id || !packs.some((p) => p.id === s.pack_id)),
    },
  ].filter((section) => section.items.length > 0);
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
        <div className="grid max-h-80 gap-3 overflow-y-auto" data-testid="sticker-list">
          {sections.map((section) => (
            <section key={section.id} aria-label={section.name || undefined} className="grid gap-1">
              {section.name && (
                <h4 className="sticky top-0 bg-popover py-0.5 text-xs font-medium text-muted-foreground">
                  {section.name}
                </h4>
              )}
              <ul className="grid grid-cols-4 gap-1">
                {section.items.map((s) => (
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
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
