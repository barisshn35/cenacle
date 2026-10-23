// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { cn } from '@cenacle/ui/lib/utils';
import { initials } from '../auth/sign-out';
import { usePictureUrl } from './format';
import { useProfile, type Profile } from './profiles';

// Never below 24px, initials never below 11px (docs/design/v0.29).
const SIZES = {
  xs: 'size-6 text-[11px]',
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-xs',
  lg: 'size-20 text-2xl',
} as const;

const TINTS = ['bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3', 'bg-avatar-4', 'bg-avatar-5'] as const;

/** A quiet paper-world tint behind the initials, the same for a name every time. */
function tint(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

/**
 * A round profile picture, or the initials of the name. Decorative: the name
 * is always next to it (or in the label of what it is part of).
 */
export function Avatar({
  name,
  profile,
  size = 'md',
  className,
  cssInitials,
}: {
  name: string;
  profile: Pick<Profile, 'avatar_url' | 'avatar_still_url'> | null;
  size?: keyof typeof SIZES;
  className?: string;
  /**
   * Draw the initials with CSS: inside a control named otherwise (the status
   * button), text would contradict its name (axe label-content-name-mismatch).
   */
  cssInitials?: boolean;
}) {
  const url = usePictureUrl(profile);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-avatar-ink',
        tint(name),
        SIZES[size],
        className,
      )}
    >
      {url && failed !== url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailed(url)}
        />
      ) : cssInitials ? (
        <span data-initials={initials(name)} className="after:content-[attr(data-initials)]" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** The avatar of a person by id (their profile is read once and shared). */
export function UserAvatar({
  userId,
  name,
  size,
  className,
}: {
  userId: string;
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const profile = useProfile(userId);
  return <Avatar name={name} profile={profile} size={size} className={className} />;
}
