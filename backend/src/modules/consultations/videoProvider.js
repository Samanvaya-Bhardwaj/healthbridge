import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';

/**
 * Video adapter (ADR-0007, ADR-0025). The backend never relays media: it names a room
 * per consultation and issues short-lived, per-participant join tokens after
 * authorisation. Room names are random (never patient or appointment identifiers).
 *
 *   mock     development/test/demo: a signed token for an in-app placeholder room
 *   livekit  LiveKit access tokens (HS256 JWT with a video grant for one room)
 *
 * @typedef {{ provider: string, url: string|null, room: string, token: string, expiresAt: Date }} JoinGrant
 * @typedef {{ name: string, newRoom(): string, joinGrant(args: { room: string, identity: string, displayName: string, role: 'doctor'|'patient' }): Promise<JoinGrant> }} VideoProvider
 */

/** @returns {VideoProvider} */
export function createVideoProvider(video) {
  const ttl = video.tokenTtlSeconds;
  const newRoom = () => `hb-${randomBytes(12).toString('base64url')}`;
  // Participant identities are opaque hashes; display names are shown in the call only.
  const opaque = (identity) => createHash('sha256').update(identity).digest('hex').slice(0, 24);

  if (video.provider === 'livekit') {
    const secret = new TextEncoder().encode(video.livekit.apiSecret);
    return {
      name: 'livekit',
      newRoom,
      async joinGrant({ room, identity, displayName, role }) {
        const expiresAt = new Date(Date.now() + ttl * 1000);
        const token = await new SignJWT({
          name: displayName,
          video: {
            room,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            // Only the doctor may manage the room.
            roomAdmin: role === 'doctor',
          },
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer(video.livekit.apiKey)
          .setSubject(opaque(identity))
          .setNotBefore('0s')
          .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
          .sign(secret);
        return { provider: 'livekit', url: video.livekit.url, room, token, expiresAt };
      },
    };
  }

  const secret = Buffer.from(
    hkdfSync('sha256', video.mockSecret, 'healthbridge', 'mock-video-token', 32),
  );
  return {
    name: 'mock',
    newRoom,
    async joinGrant({ room, identity, displayName, role }) {
      const expiresAt = new Date(Date.now() + ttl * 1000);
      const token = await new SignJWT({ room, role, name: displayName })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('healthbridge-mock-video')
        .setSubject(opaque(identity))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(secret);
      return { provider: 'mock', url: null, room, token, expiresAt };
    },
  };
}
