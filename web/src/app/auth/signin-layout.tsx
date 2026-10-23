// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '@cenacle/ui/brand';
import { AppearanceControls } from '../shell/appearance-controls';

/**
 * The sign-in pages of the chat app: the form on the left and, on wide
 * screens, a record of where the person is signing in on the right.
 */
export function SigninLayout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr_auto] bg-panel">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-10 sm:py-5">
        <Logo variant="lockup" size={28} />
        <AppearanceControls />
      </header>
      <main className="grid content-start items-center justify-center gap-10 px-4 pt-6 pb-10 sm:px-10 lg:grid-cols-[minmax(0,420px)_minmax(0,380px)] lg:content-center lg:gap-24 lg:pt-0">
        <section className="flex min-w-0 flex-col">{children}</section>
        <div className="hidden lg:block">{aside}</div>
      </main>
      <footer className="flex flex-wrap justify-between gap-2 border-t px-4 py-4 text-[13px] text-muted-foreground sm:px-10">
        <span>{t('auth.footer.product')}</span>
        <span>{t('auth.help')}</span>
      </footer>
    </div>
  );
}

/** A framed record of facts (label above value), like the channel title block. */
export function SigninRecord({
  title,
  icon,
  children,
  note,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <aside
      aria-label={title}
      className="overflow-hidden rounded-[10px] border border-rule-strong bg-background"
    >
      <h2 className="flex items-center gap-2 border-b border-rule-strong px-4 py-3 text-[13px] font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>
      {children}
      {note && (
        <p className="flex gap-2 border-t border-rule-strong px-4 py-2.5 text-[13px] leading-5 text-muted-foreground">
          {note}
        </p>
      )}
    </aside>
  );
}
