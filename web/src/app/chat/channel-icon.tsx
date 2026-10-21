// SPDX-License-Identifier: Apache-2.0
import { MegaphoneIcon, MessagesSquareIcon } from 'lucide-react';
import type { Channel } from './data';

/** Icon of a channel kind; the label says the kind to screen readers. */
export function ChannelIcon({
  kind,
  label,
  className,
}: {
  kind: Channel['kind'];
  label?: string;
  className?: string;
}) {
  const Icon = kind === 'announcement' ? MegaphoneIcon : MessagesSquareIcon;
  return label ? (
    <Icon aria-label={label} role="img" strokeWidth={1.75} className={className} />
  ) : (
    <Icon aria-hidden strokeWidth={1.75} className={className} />
  );
}
