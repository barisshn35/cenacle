// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { dateLocale } from '../../i18n/time-format';
import { profileQuery } from '../profile/profiles';

/** A person's current name; someone whose account is gone has none. */
function usePersonName(id: string | undefined) {
  const { t } = useTranslation();
  const query = useQuery({ ...profileQuery(id ?? ''), enabled: Boolean(id) });
  if (!id) return t('collab.origin.someone');
  if (query.isPending) return '…';
  return query.data?.display_name ?? t('collab.origin.someone');
}

/** "Added by Ada, 3 Nov 2026" (or "Changed by…"): who did it and when. */
export function Origin({
  by,
  at,
  verb,
  className,
}: {
  by?: string;
  at?: string;
  verb: 'added' | 'changed';
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const name = usePersonName(by);
  if (!at) return null;
  const when = new Date(at);
  const fmt = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  const full = new Intl.DateTimeFormat(dateLocale(i18n.language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <span className={className} data-testid={`origin-${verb}`}>
      {t(`collab.origin.${verb}`, { name })}
      {', '}
      <time dateTime={at} title={full.format(when)} className="tabular-nums">
        {fmt.format(when)}
      </time>
    </span>
  );
}

/** Who added a row and, if someone changed it since, who did last. */
export function RowOrigin({
  item,
  className,
}: {
  item: { created_by?: string; created_at: string; updated_by?: string; updated_at: string };
  className?: string;
}) {
  return (
    <span className={className}>
      <Origin by={item.created_by} at={item.created_at} verb="added" />
      {item.updated_by && (
        <>
          <br />
          <Origin by={item.updated_by} at={item.updated_at} verb="changed" />
        </>
      )}
    </span>
  );
}
