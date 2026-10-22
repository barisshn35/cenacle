// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from 'react-i18next';

/** "30 s", "5 min", "1 h": a burn time, short. */
export function useBurnLabel() {
  const { i18n } = useTranslation();
  return (seconds: number) => {
    const [value, unit] =
      seconds >= 3600
        ? [seconds / 3600, 'hour']
        : seconds >= 60
          ? [seconds / 60, 'minute']
          : [seconds, 'second'];
    return new Intl.NumberFormat(i18n.language, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
    }).format(value);
  };
}
