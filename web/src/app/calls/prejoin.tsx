// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { MicIcon, MicOffIcon, Volume2Icon, VideoIcon, VideoOffIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@cenacle/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@cenacle/ui/components/dialog';
import { cn } from '@cenacle/ui/lib/utils';
import { useSession } from '../auth/session';
import { Avatar } from '../profile/avatar';
import { useProfile } from '../profile/profiles';
import { playSound } from '../notifications/sounds';
import { loadJoinPrefs, saveJoinPrefs, usePreJoin, type JoinPrefs } from './prejoin-state';

const selectClass =
  'min-h-target h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';

/** The camera's picture and the microphone's level while choosing. */
function usePreview(prefs: JoinPrefs) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [level, setLevel] = useState(0);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let current: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let frame = 0;
    const id = (value: string) => (value ? { deviceId: { exact: value } } : true);
    if (!prefs.audio && !prefs.camera) return;
    navigator.mediaDevices
      .getUserMedia({
        audio: prefs.audio ? id(prefs.mic) : false,
        video: prefs.camera ? id(prefs.cam) : false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        current = s;
        setBlocked(false);
        setStream(s);
        if (!prefs.audio || !s.getAudioTracks().length) return;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        let last = 0;
        const tick = (now: number) => {
          frame = requestAnimationFrame(tick);
          if (now - last < 80) return;
          last = now;
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 64));
        };
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!cancelled) setBlocked(true);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      void ctx?.close();
      current?.getTracks().forEach((t) => t.stop());
    };
  }, [prefs.audio, prefs.camera, prefs.mic, prefs.cam]);
  // With both off nothing is captured: the last picture and level do not linger.
  const on = prefs.audio || prefs.camera;
  return { stream: on ? stream : null, level: on ? level : 0, blocked };
}

/**
 * The check before joining a call: see oneself, hear the microphone move,
 * pick the devices and whether to come in with the microphone and camera on.
 */
export function PreJoinDialog() {
  const open = usePreJoin((s) => s.open);
  if (!open) return null;
  return <PreJoin key={open.title} />;
}

function PreJoin() {
  const { t } = useTranslation('calls');
  const open = usePreJoin((s) => s.open)!;
  const ids = { mic: useId(), cam: useId(), speaker: useId(), show: useId() };
  const [prefs, setPrefs] = useState(loadJoinPrefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [joining, setJoining] = useState(false);
  const { stream, level, blocked } = usePreview(prefs);
  const video = useRef<HTMLVideoElement>(null);
  const self = useSession().user;
  const profile = useProfile(self.id);
  const set = (patch: Partial<JoinPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const close = () => usePreJoin.setState({ open: null });

  useEffect(() => {
    const update = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then(setDevices)
        .catch(() => undefined);
    update();
    navigator.mediaDevices.addEventListener('devicechange', update);
    return () => navigator.mediaDevices.removeEventListener('devicechange', update);
    // Names show once access is granted: list them again when a stream starts.
  }, [stream]);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream?.getVideoTracks().length ? stream : null;
  }, [stream]);

  const join = () => {
    saveJoinPrefs(prefs);
    setJoining(true);
    void open
      .go(prefs)
      .catch(() => undefined)
      .finally(close);
  };
  const testSpeaker = async () => {
    // The chosen speaker where the browser lets a page pick one.
    const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (prefs.speaker && ctx.setSinkId) await ctx.setSinkId(prefs.speaker).catch(() => undefined);
    await ctx.close();
    playSound('chime', 80);
  };
  const choices = (kind: MediaDeviceKind) =>
    devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
  const camOn = prefs.camera && !!stream?.getVideoTracks().length;

  return (
    <Dialog open onOpenChange={(o) => !o && !joining && close()}>
      <DialogContent className="sm:max-w-3xl" data-testid="prejoin">
        <DialogHeader>
          <DialogTitle>{open.title}</DialogTitle>
          <DialogDescription>{t('prejoin.hint')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="grid gap-3">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-muted">
              <video
                ref={video}
                autoPlay
                muted
                playsInline
                aria-label={t('prejoin.preview')}
                className={cn('size-full -scale-x-100 object-cover', !camOn && 'hidden')}
              />
              {!camOn && (
                <div className="grid justify-items-center gap-2 text-sm text-muted-foreground">
                  <Avatar name={self.display_name} profile={profile} size="lg" />
                  {prefs.camera && blocked ? t('prejoin.blocked') : t('prejoin.cameraOff')}
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant={prefs.audio ? 'outline' : 'secondary'}
                aria-pressed={prefs.audio}
                onClick={() => set({ audio: !prefs.audio })}
              >
                {prefs.audio ? (
                  <MicIcon data-icon="inline-start" />
                ) : (
                  <MicOffIcon data-icon="inline-start" />
                )}
                {prefs.audio ? t('prejoin.micOn') : t('prejoin.micOff')}
              </Button>
              <Button
                variant={prefs.camera ? 'outline' : 'secondary'}
                aria-pressed={prefs.camera}
                onClick={() => set({ camera: !prefs.camera })}
              >
                {prefs.camera ? (
                  <VideoIcon data-icon="inline-start" />
                ) : (
                  <VideoOffIcon data-icon="inline-start" />
                )}
                {prefs.camera ? t('prejoin.cameraOn') : t('prejoin.cameraOffButton')}
              </Button>
            </div>
          </div>
          <div className="grid content-start gap-4">
            <div className="grid gap-1.5">
              <label htmlFor={ids.mic} className="text-sm font-medium">
                {t('audio')}
              </label>
              <select
                id={ids.mic}
                className={selectClass}
                value={prefs.mic}
                onChange={(e) => set({ mic: e.target.value })}
              >
                <option value="">{t('defaultDevice')}</option>
                {choices('audioinput').map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `${t('audio')} ${i + 1}`}
                  </option>
                ))}
              </select>
              {/* The level says the microphone hears; the words say so without the bar. */}
              <div className="flex items-center gap-2" data-testid="mic-level">
                <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full origin-left rounded-full bg-accent-brand transition-transform duration-75"
                    style={{ transform: `scaleX(${prefs.audio ? level : 0})` }}
                  />
                </span>
                <span className="text-xs text-muted-foreground" aria-live="polite">
                  {!prefs.audio
                    ? t('prejoin.micMuted')
                    : level > 0.08
                      ? t('prejoin.hearing')
                      : t('prejoin.speak')}
                </span>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={ids.cam} className="text-sm font-medium">
                {t('camera')}
              </label>
              <select
                id={ids.cam}
                className={selectClass}
                value={prefs.cam}
                onChange={(e) => set({ cam: e.target.value })}
              >
                <option value="">{t('defaultDevice')}</option>
                {choices('videoinput').map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `${t('camera')} ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={ids.speaker} className="text-sm font-medium">
                {t('speaker')}
              </label>
              <div className="flex gap-2">
                <select
                  id={ids.speaker}
                  className={selectClass}
                  value={prefs.speaker}
                  disabled={!('setSinkId' in HTMLMediaElement.prototype)}
                  onChange={(e) => set({ speaker: e.target.value })}
                >
                  <option value="">{t('defaultDevice')}</option>
                  {choices('audiooutput').map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `${t('speaker')} ${i + 1}`}
                    </option>
                  ))}
                </select>
                <Button variant="outline" onClick={() => void testSpeaker()}>
                  <Volume2Icon data-icon="inline-start" />
                  {t('prejoin.test')}
                </Button>
              </div>
            </div>
            <label
              htmlFor={ids.show}
              data-target
              className="flex min-h-target items-center gap-2 text-sm"
            >
              <input
                id={ids.show}
                type="checkbox"
                checked={prefs.preview}
                onChange={(e) => set({ preview: e.target.checked })}
                className="size-4 accent-(--accent-brand)"
                data-target-exempt
              />
              {t('prejoin.always')}
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={joining} onClick={close}>
            {t('prejoin.cancel')}
          </Button>
          <Button disabled={joining} aria-busy={joining || undefined} onClick={join}>
            {open.starting ? t('prejoin.start') : t('prejoin.join')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
