// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, apiFetch, type components } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { Skeleton } from '@cenacle/ui/components/skeleton';

type MailServer = components['schemas']['MailServer'];
type Security = MailServer['security'];

const PORTS: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };
const QUERY_KEY = ['admin', 'mail-server'];

/** The outgoing mail server administrators set: meeting invitations and notification e-mails. */
export function MailServerSection() {
  const queryClient = useQueryClient();
  const server = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<MailServer>('/api/admin/mail-server'),
  });
  if (!server.data) return <Skeleton className="h-60" />;
  return (
    <MailServerForm
      // A fresh form after each save: the fields show what is stored.
      key={JSON.stringify(server.data)}
      server={server.data}
      onSaved={(s) => {
        queryClient.setQueryData(QUERY_KEY, s);
        // Whether e-mail can be chosen in people's notification settings.
        void queryClient.invalidateQueries({ queryKey: ['me', 'notifications'] });
      }}
    />
  );
}

function MailServerForm({
  server,
  onSaved,
}: {
  server: MailServer;
  onSaved: (s: MailServer) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [host, setHost] = useState(server.host);
  const [port, setPort] = useState(String(server.port));
  const [security, setSecurity] = useState<Security>(server.security);
  const [username, setUsername] = useState(server.username);
  const [password, setPassword] = useState('');
  const [from, setFrom] = useState(server.from);
  const [turningOff, setTurningOff] = useState(false);
  const save = useMutation({
    mutationFn: (body: Omit<MailServer, 'has_password' | 'managed'>) =>
      apiFetch<MailServer>('/api/admin/mail-server', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (s) => {
      onSaved(s);
      toast.success(s.host ? t('console.mailServer.saved') : t('console.mailServer.turnedOff'));
    },
  });
  const problem = save.error instanceof ApiError ? save.error.problem : undefined;
  const titleId = `${id}-title`;

  if (server.managed) {
    return (
      <section aria-labelledby={titleId} className="flex flex-col gap-1.5">
        <h3 id={titleId} className="text-sm font-semibold">
          {t('console.mailServer.title')}
        </h3>
        <p className="text-sm">{t('console.mailServer.managed', { host: server.host })}</p>
      </section>
    );
  }

  const account = security !== 'none';
  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          host,
          port: Number(port),
          security,
          username: account ? username : '',
          from,
          ...(account && password ? { password } : {}),
        });
      }}
    >
      <div className="grid gap-1">
        <h3 id={titleId} className="text-sm font-semibold">
          {t('console.mailServer.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('console.mailServer.hint')}</p>
        {!server.host && (
          <p className="text-xs text-muted-foreground" data-testid="mail-server-off">
            {t('console.mailServer.off')}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-host`}>{t('console.mailServer.host')}</Label>
          <Input
            id={`${id}-host`}
            className="font-mono"
            value={host}
            spellCheck={false}
            autoComplete="off"
            placeholder="mail.example.com"
            aria-describedby={`${id}-host-hint`}
            onChange={(e) => setHost(e.target.value)}
          />
          <p id={`${id}-host-hint`} className="text-xs text-muted-foreground">
            {t('console.mailServer.hostHint')}
          </p>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-port`}>{t('console.mailServer.port')}</Label>
          <Input
            id={`${id}-port`}
            className="font-mono tabular-nums"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          />
        </div>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t('console.mailServer.security')}</legend>
        {(['starttls', 'tls', 'none'] as const).map((s) => (
          <label key={s} className="flex min-h-target items-center gap-2.5 text-sm">
            <input
              type="radio"
              name={`${id}-security`}
              className="size-4"
              data-target-exempt
              checked={security === s}
              onChange={() => {
                // The usual port follows the connection, unless one was typed.
                if (port === '' || Number(port) === PORTS[security]) setPort(String(PORTS[s]));
                setSecurity(s);
              }}
            />
            {t(`console.mailServer.securities.${s}`)}
          </label>
        ))}
        {!account && (
          <p className="text-xs text-muted-foreground">
            {t('console.mailServer.noAccountInClear')}
          </p>
        )}
      </fieldset>
      {account && (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-username`}>{t('console.mailServer.username')}</Label>
            <Input
              id={`${id}-username`}
              value={username}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('console.mailServer.usernamePlaceholder')}
              aria-describedby={`${id}-username-hint`}
              onChange={(e) => setUsername(e.target.value)}
            />
            <p id={`${id}-username-hint`} className="text-xs text-muted-foreground">
              {t('console.mailServer.usernameHint')}
            </p>
          </div>
          {username.trim() !== '' && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-password`}>{t('console.mailServer.password')}</Label>
              <Input
                id={`${id}-password`}
                type="password"
                // Not the administrator's own password: browsers must not fill it in.
                autoComplete="new-password"
                value={password}
                aria-describedby={`${id}-password-hint`}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p id={`${id}-password-hint`} className="text-xs text-muted-foreground">
                {server.has_password
                  ? t('console.mailServer.passwordKept')
                  : t('console.mailServer.passwordHint')}
              </p>
            </div>
          )}
        </>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-from`}>{t('console.mailServer.from')}</Label>
        <Input
          id={`${id}-from`}
          value={from}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('console.mailServer.fromPlaceholder')}
          aria-describedby={`${id}-from-hint`}
          onChange={(e) => setFrom(e.target.value)}
        />
        <p id={`${id}-from-hint`} className="text-xs text-muted-foreground">
          {t('console.mailServer.fromHint')}
        </p>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem.detail ?? t('console.changeFailed')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending} aria-busy={save.isPending || undefined}>
          {t('console.mailServer.save')}
        </Button>
        {server.host && (
          <Button
            type="button"
            variant="outline"
            disabled={save.isPending}
            onClick={() => setTurningOff(true)}
          >
            {t('console.mailServer.turnOff')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={turningOff}
        onOpenChange={setTurningOff}
        severity="s2"
        title={t('console.mailServer.turnOffTitle')}
        description={<p>{t('console.mailServer.turnOffDescription')}</p>}
        confirmLabel={t('console.mailServer.turnOff')}
        onConfirm={async () => {
          await save.mutateAsync({
            host: '',
            port: 587,
            security: 'starttls',
            username: '',
            from: '',
          });
        }}
      />
    </form>
  );
}
