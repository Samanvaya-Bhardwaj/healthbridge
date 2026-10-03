import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { Alert } from '../../components/ui/Alert.jsx';

/**
 * Live consultation video over LiveKit (ADR-0025, ADR-0028). Media flows directly between
 * the browser and the LiveKit server; HealthBridge only issues a short-lived token for
 * one room. Nothing is recorded. The client library is loaded only when a call starts.
 */
export function VideoRoom({ url, token, onLeave }) {
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const roomRef = useRef(null);
  const [state, setState] = useState('connecting');
  const [others, setOthers] = useState(0);
  const [mediaError, setMediaError] = useState(null);
  const [muted, setMuted] = useState({ camera: false, microphone: false });

  useEffect(() => {
    let cancelled = false;
    let room;
    (async () => {
      try {
        const { Room, RoomEvent, Track } = await import('livekit-client');
        if (cancelled) return;
        room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;
        const count = () => setOthers(room.remoteParticipants.size);
        room
          .on(RoomEvent.TrackSubscribed, (track) => {
            if (!remoteRef.current) return;
            const el = track.attach();
            el.dataset.remote = track.kind;
            if (track.kind === Track.Kind.Video) {
              el.className = 'h-full w-full rounded-lg bg-black object-cover';
            }
            remoteRef.current.appendChild(el);
          })
          .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
          .on(RoomEvent.LocalTrackPublished, (publication) => {
            if (publication.track?.kind === Track.Kind.Video && localRef.current) {
              publication.track.attach(localRef.current);
            }
          })
          .on(RoomEvent.ParticipantConnected, count)
          .on(RoomEvent.ParticipantDisconnected, count)
          .on(RoomEvent.Disconnected, () => !cancelled && setState('ended'));
        await room.connect(url, token);
        if (cancelled) return;
        count();
        setState('connected');
        try {
          await room.localParticipant.enableCameraAndMicrophone();
        } catch {
          // Joined without media: the user can still hear and see the other side.
          setMediaError(
            'Camera or microphone is unavailable or blocked. Allow access in your browser to be seen and heard.',
          );
        }
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      room?.disconnect();
      roomRef.current = null;
    };
  }, [url, token]);

  const toggle = async (kind) => {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted[kind];
    try {
      if (kind === 'camera') await room.localParticipant.setCameraEnabled(!next);
      else await room.localParticipant.setMicrophoneEnabled(!next);
      setMuted((m) => ({ ...m, [kind]: next }));
    } catch {
      setMediaError('Could not change your camera or microphone.');
    }
  };

  if (state === 'failed') {
    return (
      <Alert tone="error">
        Could not connect to the video service. Check your connection and try again.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative grid h-72 place-items-center overflow-hidden rounded-lg bg-black text-sm text-white/80">
        <div ref={remoteRef} className="absolute inset-0" aria-label="Other participant" />
        {others === 0 && (
          <p role="status" className="relative">
            {state === 'connecting' ? 'Connecting…' : 'Waiting for the other participant to join…'}
          </p>
        )}
        <video
          ref={localRef}
          muted
          playsInline
          aria-label="Your camera"
          className="absolute bottom-3 right-3 h-24 w-32 rounded-md border border-white/30 bg-black object-cover"
        />
      </div>
      {mediaError && <Alert tone="warning">{mediaError}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          aria-pressed={muted.microphone}
          disabled={state !== 'connected'}
          onClick={() => toggle('microphone')}
        >
          {muted.microphone ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="secondary"
          aria-pressed={muted.camera}
          disabled={state !== 'connected'}
          onClick={() => toggle('camera')}
        >
          {muted.camera ? 'Start camera' : 'Stop camera'}
        </Button>
        <Button variant="danger" onClick={onLeave}>
          Leave call
        </Button>
      </div>
      <p className="text-xs text-text-subtle">
        Calls are peer-to-server encrypted and never recorded by HealthBridge.
      </p>
    </div>
  );
}
