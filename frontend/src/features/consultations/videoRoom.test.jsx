import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VideoRoom } from './VideoRoom.jsx';

const rooms = [];
vi.mock('livekit-client', () => {
  class Room {
    constructor() {
      this.handlers = {};
      this.remoteParticipants = new Map();
      this.connect = vi.fn(async () => {});
      this.disconnect = vi.fn();
      this.localParticipant = {
        enableCameraAndMicrophone: vi.fn(async () => {
          if (Room.denyMedia) throw new Error('NotAllowedError');
        }),
        setMicrophoneEnabled: vi.fn(async () => {}),
        setCameraEnabled: vi.fn(async () => {}),
      };
      rooms.push(this);
    }
    on(event, fn) {
      this.handlers[event] = fn;
      return this;
    }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: 'ts',
      TrackUnsubscribed: 'tu',
      LocalTrackPublished: 'ltp',
      ParticipantConnected: 'pc',
      ParticipantDisconnected: 'pd',
      Disconnected: 'd',
    },
    Track: { Kind: { Video: 'video', Audio: 'audio' } },
  };
});

afterEach(async () => {
  rooms.length = 0;
  (await import('livekit-client')).Room.denyMedia = false;
});

describe('live video room', () => {
  it('connects with the issued token, publishes camera and mic, and leaves cleanly', async () => {
    const onLeave = vi.fn();
    const view = render(
      <VideoRoom url="ws://localhost:7880" token="room-token" onLeave={onLeave} />,
    );
    expect(
      await screen.findByText('Waiting for the other participant to join…'),
    ).toBeInTheDocument();
    const room = rooms[0];
    expect(room.connect).toHaveBeenCalledWith('ws://localhost:7880', 'room-token');
    expect(room.localParticipant.enableCameraAndMicrophone).toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Leave call' }));
    expect(onLeave).toHaveBeenCalled();
    view.unmount();
    expect(room.disconnect).toHaveBeenCalled();
  });

  it('stays in the call without media when the browser blocks the camera', async () => {
    (await import('livekit-client')).Room.denyMedia = true;
    render(<VideoRoom url="ws://localhost:7880" token="t" onLeave={() => {}} />);
    expect(await screen.findByText(/Camera or microphone is unavailable/)).toBeInTheDocument();
  });

  it('explains a connection failure', async () => {
    const { Room } = await import('livekit-client');
    const original = Room.prototype.on;
    Room.prototype.on = function on() {
      this.connect = vi.fn(async () => {
        throw new Error('ws closed');
      });
      return this;
    };
    render(<VideoRoom url="ws://localhost:7880" token="t" onLeave={() => {}} />);
    expect(await screen.findByText(/Could not connect to the video service/)).toBeInTheDocument();
    Room.prototype.on = original;
  });
});
