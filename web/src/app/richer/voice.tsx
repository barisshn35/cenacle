// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { CheckIcon, MicIcon, PauseIcon, PlayIcon, VideoIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { cn } from '@cenacle/ui/lib/utils';
import { fileUrl, recordings, type FileInfo } from '../chat/files';
import { toWaveform } from './waveform';

/** Longest recordings (ms). */
const MAX_VOICE = 5 * 60_000;
const MAX_CLIP = 60_000;

const formatTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Kind = 'voice' | 'clip';

/**
 * Records a voice message or a short video clip in the browser. The result
 * becomes a file of the message (uploaded like any other) with its length
 * and, for voice, its waveform.
 */
export function Recorder({ onRecorded }: { onRecorded: (file: File) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const preview = useRef<HTMLVideoElement>(null);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    samples: number[];
    started: number;
    keep: boolean;
    stop: () => void;
  } | null>(null);

  const supported = typeof window !== 'undefined' && 'MediaRecorder' in window;

  const start = async (k: Kind) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        k === 'voice' ? { audio: true } : { audio: true, video: { width: 640, height: 480 } },
      );
    } catch {
      toast.error(t(k === 'voice' ? 'richer.record.noMicrophone' : 'richer.record.noCamera'));
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const samples: number[] = [];
    let timer = 0;
    let audio: AudioContext | null = null;
    if (k === 'voice') {
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        samples.push(Math.sqrt(sum / data.length));
      }, 100);
    }
    const started = Date.now();
    const tick = window.setInterval(() => {
      const ms = Date.now() - started;
      setElapsed(ms);
      if (ms >= (k === 'voice' ? MAX_VOICE : MAX_CLIP)) finish(true);
    }, 250);
    const s = {
      recorder,
      stream,
      chunks,
      samples,
      started,
      keep: false,
      stop: () => {
        clearInterval(timer);
        clearInterval(tick);
        void audio?.close();
        stream.getTracks().forEach((tr) => tr.stop());
      },
    };
    session.current = s;
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      s.stop();
      session.current = null;
      setKind(null);
      setElapsed(0);
      if (!s.keep || chunks.length === 0) return;
      const type = recorder.mimeType || (k === 'voice' ? 'audio/webm' : 'video/webm');
      const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = new File(chunks, `${k}-${stamp}.${ext}`, { type });
      recordings.set(file, {
        media_kind: k,
        duration_ms: Math.min(Date.now() - started, k === 'voice' ? MAX_VOICE : MAX_CLIP),
        ...(k === 'voice' ? { waveform: toWaveform(samples) } : {}),
      });
      onRecorded(file);
    };
    recorder.start(1000);
    setKind(k);
    if (k === 'clip' && preview.current) {
      preview.current.srcObject = stream;
      void preview.current.play().catch(() => undefined);
    }
  };

  function finish(keep: boolean) {
    const s = session.current;
    if (!s) return;
    s.keep = keep;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  }

  // Leaving the composer ends a recording (nothing is kept).
  useEffect(() => {
    const current = session;
    return () => {
      const s = current.current;
      if (s && s.recorder.state !== 'inactive') s.recorder.stop();
    };
  }, []);

  if (!supported) return null;
  if (!kind) {
    return (
      <>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('richer.record.voice')}
          onClick={() => void start('voice')}
        >
          <MicIcon strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t('richer.record.clip')}
          onClick={() => void start('clip')}
        >
          <VideoIcon strokeWidth={1.75} />
        </Button>
        <video ref={preview} hidden muted playsInline />
      </>
    );
  }
  return (
    <div
      role="group"
      aria-label={t(kind === 'voice' ? 'richer.record.voice' : 'richer.record.clip')}
      className="flex items-center gap-1"
      data-testid="recording"
    >
      <video
        ref={preview}
        muted
        playsInline
        hidden={kind !== 'clip'}
        className="h-16 rounded-md bg-black"
      />
      <span className="flex items-center gap-1.5 px-1 text-sm tabular-nums" role="status">
        <span aria-hidden className="size-2 rounded-full bg-foreground motion-safe:animate-pulse" />
        {t('richer.record.recording', { time: formatTime(elapsed) })}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={t('richer.record.cancel')}
        onClick={() => finish(false)}
      >
        <XIcon strokeWidth={1.75} />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="secondary"
        aria-label={t('richer.record.done')}
        onClick={() => finish(true)}
      >
        <CheckIcon strokeWidth={1.75} />
      </Button>
    </div>
  );
}

/** A voice message: play or pause it; its waveform shows how far it got. */
export function VoicePlayer({ file }: { file: FileInfo }) {
  const { t } = useTranslation();
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const duration = file.duration_ms ?? 0;
  const levels = file.waveform?.length ? file.waveform : Array.from({ length: 32 }, () => 96);
  const progress = duration > 0 ? Math.min(1, at / duration) : 0;
  return (
    <div
      data-testid="voice"
      className="flex w-full max-w-sm items-center gap-3 rounded-full border bg-card py-1 pr-4 pl-1"
    >
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="rounded-full"
        aria-label={playing ? t('richer.voice.pause') : t('richer.voice.play')}
        onClick={() => {
          const a = audio.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
      >
        {playing ? <PauseIcon strokeWidth={1.75} /> : <PlayIcon strokeWidth={1.75} />}
      </Button>
      <div aria-hidden className="flex h-8 flex-1 items-center gap-px">
        {levels.map((v, i) => (
          <span
            key={i}
            style={{ height: `${Math.max(12, (v / 255) * 100)}%` }}
            className={cn(
              'flex-1 rounded-full',
              i / levels.length < progress ? 'bg-foreground' : 'bg-muted-foreground/40',
            )}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatTime(playing || at > 0 ? at : duration)}
      </span>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- recorded in the app: no captions exist */}
      <audio
        ref={audio}
        src={fileUrl(file.id)}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime * 1000)}
      />
    </div>
  );
}

/** A video clip recorded in the app. */
export function ClipPlayer({ file }: { file: FileInfo }) {
  const { t } = useTranslation();
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- recorded in the app: no captions exist
    <video
      data-testid="clip"
      src={fileUrl(file.id)}
      controls
      preload="metadata"
      playsInline
      aria-label={t('richer.clip.label', { name: file.name })}
      className="max-h-72 w-full max-w-sm rounded-lg border bg-black"
    />
  );
}
