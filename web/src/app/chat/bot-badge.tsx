// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';

/** Marks a bot by text and color (not color alone). */
export function BotBadge() {
  const { t } = useTranslation();
  return (
    <span
      data-testid="bot-badge"
      className="rounded bg-bot-badge px-1 py-px text-[10px] leading-none font-semibold tracking-wide text-bot-badge-foreground uppercase"
    >
      {t('bots.badge')}
    </span>
  );
}
