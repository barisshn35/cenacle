// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { DownloadIcon, ShieldCheckIcon } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { SigninLayout, SigninRecord } from './signin-layout';
import { serverAddress } from './web-app';
import { downloadsQuery } from '../desktop/desktop';
import { formatSize } from '../chat/files';

/**
 * Shown instead of the app while the administrators turned Cenacle in web
 * browsers off: the desktop and mobile apps keep working with this address.
 */
export function WebOffPage() {
  const { t, i18n } = useTranslation();
  const downloads = useQuery(downloadsQuery);
  const address = serverAddress();
  return (
    <SigninLayout
      aside={
        <SigninRecord
          title={t('webOff.server')}
          icon={<ShieldCheckIcon aria-hidden className="size-4" strokeWidth={1.75} />}
        >
          <dl>
            <div className="grid gap-0.5 px-4 pt-2.5 pb-3">
              <dt className="text-[11.5px] text-muted-foreground">{t('webOff.address')}</dt>
              <dd className="font-mono text-[13.5px]">{address}</dd>
            </div>
            <div className="grid gap-0.5 border-t px-4 pt-2.5 pb-3">
              <dt className="text-[11.5px] text-muted-foreground">{t('webOff.browsers')}</dt>
              <dd className="text-sm">{t('webOff.turnedOff')}</dd>
            </div>
          </dl>
        </SigninRecord>
      }
    >
      <div data-testid="web-off" role="status" className="flex flex-col">
        <h1 className="text-[34px] leading-[1.15] font-semibold tracking-[-0.02em] text-balance">
          {t('webOff.title')}
        </h1>
        <p className="mt-2 text-[15.5px] leading-[1.55] text-muted-foreground">
          <Trans
            i18nKey="webOff.lede"
            values={{ address }}
            components={{ b: <b className="font-mono font-medium text-foreground" /> }}
          />
        </p>
        {downloads.data && downloads.data.files.length > 0 ? (
          <div className="mt-6 flex flex-col gap-2.5" data-testid="downloads">
            {downloads.data.files.map((f) => (
              <a
                key={f.file}
                href={`/downloads/desktop/${encodeURIComponent(f.file)}`}
                download
                className="flex h-11 min-h-target items-center gap-3 rounded-[10px] border border-rule-strong bg-background px-3.5 text-[14.5px] font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <DownloadIcon
                  aria-hidden
                  className="size-4 text-muted-foreground"
                  strokeWidth={1.75}
                />
                {t(`webOff.download.${f.platform}`, { kind: t(`webOff.kinds.${f.kind}`) })}
                <span className="ms-auto font-mono text-xs font-normal text-muted-foreground">
                  {f.arch} · {formatSize(f.size, i18n.language)}
                </span>
              </a>
            ))}
            <p className="text-[12.5px] text-muted-foreground">
              {t('webOff.version', { version: downloads.data.version, address })}
            </p>
          </div>
        ) : (
          <p className="mt-6 rounded-[10px] border border-rule-strong bg-background px-4 py-3 text-sm leading-relaxed">
            {t('webOff.getApp')}
          </p>
        )}
      </div>
    </SigninLayout>
  );
}
