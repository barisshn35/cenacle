// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { dateLocale } from '../../i18n/time-format';
import {
  assistantsQuery,
  createAssistantToken,
  revokeAssistantToken,
  type AssistantToken,
} from './assistants';

const selectClass =
  'min-h-target h-8 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

function copy(text: string, done: string, fallbackId: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(done),
    () => (document.getElementById(fallbackId) as HTMLInputElement | null)?.select(),
  );
}

/** Settings → Assistants (ADR 0056): tokens for the person's AI assistants over MCP. */
export function AssistantsPanel() {
  const { t, i18n } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const data = useQuery(assistantsQuery);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState(false);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [made, setMade] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AssistantToken | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: assistantsQuery.queryKey });
  const make = useMutation({
    mutationFn: () => createAssistantToken(name.trim(), draft ? ['read', 'draft'] : ['read'], days),
    onSuccess: (r) => {
      setMade(r.token);
      setName('');
      void refresh();
    },
  });
  if (!data.data) return <Skeleton className="mt-4 h-40" />;
  const { mcp_url: url, tokens } = data.data;
  const when = new Intl.DateTimeFormat(dateLocale(i18n.language), { dateStyle: 'medium' });
  const config = made
    ? JSON.stringify(
        {
          mcpServers: {
            cenacle: { type: 'http', url, headers: { Authorization: `Bearer ${made}` } },
          },
        },
        null,
        2,
      )
    : '';

  return (
    <div className="flex flex-col gap-6 pt-4">
      <section className="flex flex-col gap-2" aria-labelledby={`${id}-what`}>
        <h3 id={`${id}-what`} className="text-sm font-semibold">
          {t('assistants.what')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('assistants.whatHint')}</p>
        <p className="text-sm text-muted-foreground">{t('assistants.privacy')}</p>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-url`}>{t('assistants.address')}</Label>
          <div className="flex gap-2">
            <Input id={`${id}-url`} readOnly value={url} onFocus={(e) => e.target.select()} />
            <Button
              variant="outline"
              onClick={() => copy(url, t('assistants.copied'), `${id}-url`)}
            >
              {t('assistants.copy')}
            </Button>
          </div>
        </div>
      </section>

      {made ? (
        <section
          className="flex flex-col gap-2 rounded-[10px] border border-accent-brand/50 p-3"
          aria-labelledby={`${id}-made`}
        >
          <h3 id={`${id}-made`} className="text-sm font-semibold">
            {t('assistants.made')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('assistants.once')}</p>
          <Label htmlFor={`${id}-token`}>{t('assistants.token')}</Label>
          <div className="flex gap-2">
            <Input id={`${id}-token`} readOnly value={made} onFocus={(e) => e.target.select()} />
            <Button onClick={() => copy(made, t('assistants.copied'), `${id}-token`)}>
              {t('assistants.copy')}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('assistants.config')}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-2 font-mono text-xs">{config}</pre>
          <Button variant="outline" className="self-start" onClick={() => setMade(null)}>
            {t('assistants.done')}
          </Button>
        </section>
      ) : (
        <form
          className="flex flex-col gap-3"
          aria-labelledby={`${id}-new`}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) make.mutate();
          }}
        >
          <h3 id={`${id}-new`} className="text-sm font-semibold">
            {t('assistants.new')}
          </h3>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('assistants.name')}</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={80}
              placeholder={t('assistants.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-sm font-medium">{t('assistants.may')}</legend>
            <label data-target className="flex min-h-target items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked
                disabled
                className="size-4 accent-primary"
                data-target-exempt
              />
              {t('assistants.scopes.read')}
            </label>
            <label data-target className="flex min-h-target items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="size-4 accent-primary"
                data-target-exempt
              />
              {t('assistants.scopes.draft')}
            </label>
            <p className="text-xs text-muted-foreground">{t('assistants.neverSends')}</p>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-days`}>{t('assistants.lasts')}</Label>
            <select
              id={`${id}-days`}
              className={selectClass}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            >
              {([7, 30, 90] as const).map((d) => (
                <option key={d} value={d}>
                  {t('assistants.days', { count: d })}
                </option>
              ))}
            </select>
          </div>
          {make.isError && (
            <InlineError
              problem={make.error instanceof ApiError ? make.error.problem : { status: 500 }}
            />
          )}
          <Button
            type="submit"
            className="self-start"
            disabled={!name.trim() || make.isPending}
            aria-busy={make.isPending || undefined}
          >
            {t('assistants.make')}
          </Button>
        </form>
      )}

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-list`}>
        <h3 id={`${id}-list`} className="text-sm font-semibold">
          {t('assistants.yours')}
        </h3>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('assistants.none')}</p>
        ) : (
          <ul className="divide-y rounded-[10px] border">
            {tokens.map((tok) => (
              <li key={tok.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{tok.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {tok.scopes.includes('draft')
                      ? t('assistants.readDraft')
                      : t('assistants.readOnly')}
                    {' · '}
                    {t('assistants.until', { date: when.format(new Date(tok.expires_at)) })}
                    {' · '}
                    {tok.last_used_at
                      ? t('assistants.used', { date: when.format(new Date(tok.last_used_at)) })
                      : t('assistants.notUsed')}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setRevoking(tok)}>
                  {t('assistants.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        severity="s2"
        title={t('assistants.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('assistants.revokeHint')}
        confirmLabel={t('assistants.revoke')}
        onConfirm={async () => {
          if (revoking) await revokeAssistantToken(revoking.id);
          setRevoking(null);
          await refresh();
        }}
      />
    </div>
  );
}
