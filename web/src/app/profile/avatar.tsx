// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { cn } from '@cenacle/ui/lib/utils';
import { initials } from '../auth/sign-out';
import { usePictureUrl } from './format';
import { useProfile, type Profile } from './profiles';

const SIZES = {
  xs: 'size-5 text-[9px]',
  sm: 'size-7 text-[10px]',
  md: 'size-9 text-xs',
  lg: 'size-20 text-2xl',
} as const;

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
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-semibold text-muted-foreground',
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
