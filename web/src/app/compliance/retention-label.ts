// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';

/** "kept 2 years", "kept 6 months", "kept 45 days". */
export function useRetentionLabel() {
  const { t } = useTranslation();
  return (days: number) =>
    days % 365 === 0
      ? t('compliance.kept.years', { count: days / 365 })
      : days % 30 === 0
        ? t('compliance.kept.months', { count: days / 30 })
        : t('compliance.kept.days', { count: days });
}

/** "2 years", "6 months", "45 days". */
export function usePeriodLabel() {
  const { t } = useTranslation();
  return (days: number) =>
    days % 365 === 0
      ? t('compliance.period.years', { count: days / 365 })
      : days % 30 === 0
        ? t('compliance.period.months', { count: days / 30 })
        : t('compliance.period.days', { count: days });
}
