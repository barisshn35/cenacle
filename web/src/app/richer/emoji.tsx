// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';
import { cn } from '@cenacle/ui/lib/utils';
import { CUSTOM_EMOJI, type CustomEmoji } from './richer';
import { useCustomEmoji } from './use-custom-emoji';

/** A custom emoji, sized like text. Unknown names stay text. */
export function CustomEmojiImage({
  name,
  emoji,
  className,
}: {
  name: string;
  emoji: Map<string, CustomEmoji>;
  className?: string;
}) {
  const e = emoji.get(name);
  if (!e) return <>{`:${name}:`}</>;
  return (
    <img
      src={e.url}
      alt={`:${name}:`}
      title={`:${name}:`}
      loading="lazy"
      decoding="async"
      className={cn('inline-block size-[1.375em] object-contain align-text-bottom', className)}
    />
  );
}

/** A reaction: an emoji, or a custom emoji's picture. */
export function ReactionEmoji({ emoji }: { emoji: string }) {
  const custom = useCustomEmoji();
  const name = CUSTOM_EMOJI.exec(emoji)?.[1];
  if (!name) return <>{emoji}</>;
  return <CustomEmojiImage name={name} emoji={custom} className="size-5" />;
}

/** The workspace's own emoji, above the standard ones in the picker. */
export function CustomEmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useTranslation();
  const custom = useCustomEmoji();
  if (custom.size === 0) return null;
  return (
    <div className="mb-2 border-b pb-2">
      <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
        {t('richer.emoji.workspace')}
      </p>
      <ul
        className="flex max-h-24 flex-wrap gap-0.5 overflow-y-auto px-1"
        data-testid="custom-emoji"
      >
        {[...custom.values()].map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-target-exempt
              aria-label={`:${e.name}:`}
              title={`:${e.name}:`}
              onClick={() => onPick(`:${e.name}:`)}
              className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <img src={e.url} alt="" className="size-6 object-contain" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
