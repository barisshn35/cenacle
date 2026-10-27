// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import { dateLocale } from '../../i18n/time-format';

/** Formats counts as the rest of the page does (1,240 in English, 1.240 in Turkish). */
export function useCountFormat(): (n: number) => string {
  const { i18n } = useTranslation();
  const f = new Intl.NumberFormat(dateLocale(i18n.language));
  return (n) => f.format(n);
}
