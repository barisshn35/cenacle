// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheckIcon,
  DownloadIcon,
  FileIcon,
  KeyRoundIcon,
  LockIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch } from '@cenacle/core/api';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Label } from '@cenacle/ui/components/label';
import { useSession } from '../auth/session';
import { MessageBody } from '../chat/markdown/message-body';
import { formatSize } from '../chat/files';
import { isConversation, reloadChannels, type Channel, type Message } from '../chat/data';
import { get, put, unb64 } from './db';
import { decryptFile } from './files';
import {
  devicesOf,
  enable,
  ensureDevice,
  fingerprint,
  open,
  type E2EDevice,
  type FileKey,
  type MLSGroup,
} from './mls';
import { createRecovery, localKey, recoveryQuery, takeRecoveryCode } from './recovery';

/** An MLS message: opened on this device, with its encrypted files. */
export function MLSContent({ message, selfId }: { message: Message; selfId: string }) {
  const { t } = useTranslation();
  const opened = useQuery({
    queryKey: ['mls-open', message.channel_id, message.body, selfId],
    queryFn: () => open(message.channel_id, selfId, message.body),
    staleTime: Infinity,
    retry: 1,
  });
  if (opened.data && 'payload' in opened.data) {
    const { t: text, f } = opened.data.payload;
    return (
      <>
        {text && <MessageBody body={text} mentions={message.mentions} selfId={selfId} />}
        {f?.length ? <EncryptedFiles files={f} /> : null}
      </>
    );
  }
  const why =
    opened.data && 'unavailable' in opened.data
      ? opened.data.unavailable === 'before'
        ? t('mls.before')
        : t('mls.broken')
      : opened.isError
        ? t('mls.broken')
        : t('e2e.opening');
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
      <LockIcon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {why}
    </p>
  );
}

const isImageType = (type: string) => /^image\/(jpeg|png|gif|webp)$/.test(type);

function EncryptedFiles({ files }: { files: FileKey[] }) {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {files.map((f) =>
        isImageType(f.type) && f.size <= 10 << 20 ? (
          <EncryptedImage key={f.id} file={f} />
        ) : (
          <EncryptedFileCard key={f.id} file={f} />
        ),
      )}
    </div>
  );
}

function useObjectURL(file: FileKey, enabled: boolean) {
  const q = useQuery({
    queryKey: ['mls-file', file],
    queryFn: async () => URL.createObjectURL(await decryptFile(file)),
    enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
  return q;
}

function EncryptedImage({ file }: { file: FileKey }) {
  const { t } = useTranslation();
  const url = useObjectURL(file, true);
  if (!url.data) {
    return url.isError ? (
      <EncryptedFileCard file={file} />
    ) : (
      <div className="h-40 w-56 animate-pulse rounded-lg bg-muted" aria-label={t('e2e.opening')} />
    );
  }
  return (
    <a href={url.data} target="_blank" rel="noopener noreferrer" className="self-start">
      <img
        src={url.data}
        alt={file.name}
        className="max-h-60 max-w-80 rounded-lg border object-contain"
      />
    </a>
  );
}

function EncryptedFileCard({ file }: { file: FileKey }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const url = URL.createObjectURL(await decryptFile(file));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex max-w-sm items-center gap-3 rounded-lg border px-3 py-2">
      <FileIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatSize(file.size, i18n.language)} · {t('mls.encryptedFile')}
        </p>
        {failed && <InlineError title={t('mls.fileFailed')} politeness="status" />}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('files.downloadNamed', { name: file.name })}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void download()}
      >
        <DownloadIcon aria-hidden strokeWidth={1.75} />
      </Button>
    </div>
  );
}

/** Turns on encryption with device keys (managers; anyone in a conversation). */
export function EnableEncryption({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const selfId = useSession().user.id;
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  if (channel.encrypted || channel.archived || !(channel.can_manage || isConversation(channel))) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 text-sm" data-testid="enable-encryption">
      <p className="text-muted-foreground">{t('mls.enableHint')}</p>
      <div>
        <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
          <LockIcon aria-hidden strokeWidth={1.75} />
          {t('mls.enable')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        severity="s2"
        irreversible
        title={t('mls.enableTitle', { name: channel.name })}
        description={t('mls.enableDescription')}
        confirmLabel={t('mls.enable')}
        onConfirm={async () => {
          await enable(channel.id, selfId);
          await reloadChannels(queryClient);
        }}
      />
    </div>
  );
}

const verifiedKey = (deviceId: string) => `verified:${deviceId}`;

/** In a channel's details: encryption with device keys, and the devices that can read. */
export function MLSInfo({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
  const group = useQuery({
    queryKey: ['mls-group', channel.id],
    queryFn: () => apiFetch<MLSGroup>(`/api/channels/${channel.id}/e2e`),
  });
  const members = group.data?.members.filter((m) => !m.stale) ?? [];
  const people = [...new Set(members.map((m) => m.user_id))];
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 text-sm" data-testid="encryption-info">
      <p className="flex items-center gap-1.5 font-medium">
        <LockIcon aria-hidden className="size-4" strokeWidth={1.75} />
        {t('mls.info')}
      </p>
      <p className="text-muted-foreground">{t('mls.infoHint')}</p>
      {group.data && (
        <details className="rounded-lg border px-3 py-2">
          <summary className="min-h-target cursor-pointer content-center">
            {t('mls.devicesInGroup', { count: members.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {people.map((userId) => (
              <PersonDevices
                key={userId}
                userId={userId}
                inGroup={members.filter((m) => m.user_id === userId).map((m) => m.device_id)}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function PersonDevices({ userId, inGroup }: { userId: string; inGroup: string[] }) {
  const devices = useQuery({ queryKey: ['e2e-devices', userId], queryFn: () => devicesOf(userId) });
  const list = devices.data?.filter((d) => inGroup.includes(d.id)) ?? [];
  return (
    <li className="flex flex-col gap-1.5">
      {list.map((d) => (
        <DeviceFingerprint key={d.id} device={d} />
      ))}
    </li>
  );
}

/** A device's fingerprint, to compare with its owner; marked verified on this device. */
function DeviceFingerprint({ device }: { device: E2EDevice }) {
  const { t } = useTranslation();
  const selfId = useSession().user.id;
  const own = device.user_id === selfId;
  const print = useQuery({
    queryKey: ['e2e-fingerprint', device.id, device.signature_key],
    queryFn: () => fingerprint(unb64(device.signature_key)),
    staleTime: Infinity,
  });
  const verified = useQuery({
    queryKey: ['e2e-verified', device.id],
    queryFn: async () => (await get<string>('meta', verifiedKey(device.id))) ?? null,
  });
  const queryClient = useQueryClient();
  const isVerified = own || (!!print.data && verified.data === print.data);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {isVerified ? (
          <BadgeCheckIcon aria-hidden className="size-4 text-primary" strokeWidth={1.75} />
        ) : (
          <ShieldAlertIcon
            aria-hidden
            className="size-4 text-muted-foreground"
            strokeWidth={1.75}
          />
        )}
        <span className="truncate">{device.name}</span>
        <span className="sr-only">{isVerified ? t('mls.verified') : t('mls.notVerified')}</span>
      </span>
      <code className="font-mono text-xs text-muted-foreground">{print.data}</code>
      {!own && print.data && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={isVerified}
          onClick={() =>
            void put('meta', verifiedKey(device.id), isVerified ? '' : print.data).then(() =>
              queryClient.invalidateQueries({ queryKey: ['e2e-verified', device.id] }),
            )
          }
        >
          {isVerified ? t('mls.unverify') : t('mls.markVerified')}
        </Button>
      )}
    </div>
  );
}

/** Settings: this device's keys, one's devices, and the recovery key. */
export function EncryptionSettings() {
  const { t } = useTranslation();
  const selfId = useSession().user.id;
  const queryClient = useQueryClient();
  const self = useQuery({
    queryKey: ['e2e-self', selfId],
    queryFn: async () => (await get<{ id: string }>('device', selfId)) ?? null,
  });
  const mine = useQuery({
    queryKey: ['e2e-mine', selfId],
    queryFn: () => apiFetch<{ devices: E2EDevice[] }>('/api/e2e/devices').then((r) => r.devices),
  });
  const [revoking, setRevoking] = useState<E2EDevice | null>(null);
  return (
    <section
      aria-labelledby="settings-encryption"
      className="flex flex-col gap-2"
      data-testid="encryption-settings"
    >
      <h3 id="settings-encryption" className="text-sm font-semibold">
        {t('mls.settings')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('mls.settingsHint')}</p>
      {mine.data && mine.data.length > 0 && (
        <ul className="flex flex-col divide-y rounded-[10px] border border-rule-strong bg-background px-3">
          {mine.data.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <DeviceFingerprint device={d} />
                {self.data?.id === d.id && (
                  <p className="text-xs text-muted-foreground">{t('mls.thisDevice')}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('mls.removeDevice', { name: d.name })}
                onClick={() => setRevoking(d)}
              >
                <Trash2Icon aria-hidden strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <RecoveryPanel />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        severity="s2"
        title={t('mls.removeDeviceTitle', { name: revoking?.name ?? '' })}
        description={t('mls.removeDeviceDescription')}
        confirmLabel={t('mls.removeDeviceConfirm')}
        onConfirm={async () => {
          if (!revoking) return;
          await apiFetch<void>(`/api/e2e/devices/${revoking.id}`, { method: 'DELETE' });
          setRevoking(null);
          await queryClient.invalidateQueries({ queryKey: ['e2e-mine', selfId] });
        }}
      />
    </section>
  );
}

function RecoveryPanel() {
  const { t } = useTranslation();
  const id = useId();
  const selfId = useSession().user.id;
  const queryClient = useQueryClient();
  const recovery = useQuery(recoveryQuery(selfId));
  const here = useQuery({
    queryKey: ['e2e-recovery-here', selfId],
    queryFn: async () => !!(await localKey(selfId)),
  });
  const [code, setCode] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [replace, setReplace] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['e2e-recovery', selfId] }),
      queryClient.invalidateQueries({ queryKey: ['e2e-recovery-here', selfId] }),
    ]);
  const create = useMutation({
    mutationFn: async () => {
      await ensureDevice(selfId);
      return createRecovery(selfId);
    },
    onSuccess: (r) => {
      setCode(r.code);
      void refresh();
      // Making the key registered this device if it was not yet.
      void queryClient.invalidateQueries({ queryKey: ['e2e-mine', selfId] });
      void queryClient.invalidateQueries({ queryKey: ['e2e-self', selfId] });
    },
  });
  const use = useMutation({
    mutationFn: () => takeRecoveryCode(selfId, typed),
    onSuccess: (ok) => {
      if (ok) {
        setTyped('');
        void refresh();
        void queryClient.invalidateQueries({ queryKey: ['mls-open'] });
      }
    },
  });
  if (!recovery.data) return null;
  const r = recovery.data;
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-rule-strong bg-background p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRoundIcon aria-hidden className="size-4" strokeWidth={1.75} />
        {t('mls.recovery')}
      </p>
      <p className="text-sm text-muted-foreground">
        {r.set
          ? here.data
            ? t('mls.recoveryOn')
            : t('mls.recoveryElsewhere')
          : t('mls.recoveryOff')}
      </p>
      {r.escrow_key && <p className="text-sm text-muted-foreground">{t('mls.escrowNotice')}</p>}
      {code && (
        <div className="flex flex-col gap-1" role="status">
          <p className="text-sm font-medium">{t('mls.codeShown')}</p>
          <code
            className="rounded-md bg-muted px-3 py-2 font-mono text-sm break-words select-all"
            data-testid="recovery-code"
          >
            {code}
          </code>
        </div>
      )}
      {r.set && !here.data && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            use.mutate();
          }}
        >
          <Label htmlFor={`${id}-code`}>{t('mls.enterCode')}</Label>
          <div className="flex gap-2">
            <Input
              id={`${id}-code`}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              aria-invalid={use.data === false || undefined}
              onChange={(e) => setTyped(e.target.value)}
            />
            <Button type="submit" disabled={!typed || use.isPending} aria-busy={use.isPending}>
              {t('mls.useCode')}
            </Button>
          </div>
          {use.data === false && <InlineError title={t('mls.wrongCode')} />}
        </form>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={create.isPending}
          aria-busy={create.isPending}
          onClick={() => (r.set ? setReplace(true) : create.mutate())}
        >
          {r.set ? t('mls.newCode') : t('mls.makeCode')}
        </Button>
      </div>
      {create.isError && (
        <InlineError
          problem={create.error instanceof ApiError ? create.error.problem : { status: 0 }}
        />
      )}
      <ConfirmDialog
        open={replace}
        onOpenChange={setReplace}
        severity="s2"
        irreversible
        title={t('mls.newCodeTitle')}
        description={t('mls.newCodeDescription')}
        confirmLabel={t('mls.newCode')}
        onConfirm={async () => {
          await create.mutateAsync();
          setReplace(false);
        }}
      />
    </div>
  );
}
