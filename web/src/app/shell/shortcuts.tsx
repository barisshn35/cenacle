// SPDX-License-Identifier: AGPL-3.0-only
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { Kbd } from '@cenacle/ui/components/kbd';
import { keyName, useShortcutGroups, useShortcutsDialog } from './shortcuts-state';

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <Kbd key={k} className="min-w-6 justify-center font-sans">
          {keyName(k)}
        </Kbd>
      ))}
    </span>
  );
}

/** Every keyboard shortcut, in groups (Ctrl+/ opens it). */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const { open, setOpen } = useShortcutsDialog();
  const groups = useShortcutGroups();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[65svh] gap-6 overflow-y-auto sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{g.title}</h3>
              <dl className="divide-y rounded-[10px] border">
                {g.items.map((s) => (
                  <div key={s.label} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <dt className="min-w-0 flex-1">{s.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5">
                      <Keys keys={s.keys} />
                      {s.or && (
                        <>
                          <span className="text-xs text-muted-foreground">{t('shortcuts.or')}</span>
                          <Keys keys={s.or} />
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
