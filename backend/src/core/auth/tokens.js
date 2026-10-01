import { createHash } from 'node:crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { newId } from '../db/ids.js';

const ALGORITHM = 'EdDSA';
const ACCESS_TOKEN_TYPE = 'at+jwt'; // RFC 9068: prevents using other JWTs as access tokens

export class TokenError extends Error {
  /** @param {'token_expired' | 'token_invalid'} code */
  constructor(code) {
    super(code === 'token_expired' ? 'Access token expired' : 'Access token invalid');
    this.name = 'TokenError';
    this.code = code;
  }
}

/** Stable key ID: truncated SHA-256 thumbprint of the SPKI-encoded public key. */
export function keyId(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

/**
 * Short-lived Ed25519-signed access tokens (ADR-0015).
 *
 * The token carries only identifiers (sub = user, sid = session). Roles, permissions,
 * account status and session validity are resolved from the database on every request,
 * so revocation and role changes take effect immediately.
 *
 * @param {{
 *   signingKeys: { privateKey: import('node:crypto').KeyObject, publicKey: import('node:crypto').KeyObject, previousPublicKeys: import('node:crypto').KeyObject[] },
 *   issuer: string, audience: string, accessTokenTtlSeconds: number,
 *   now?: () => number,
 * }} options
 */
export function createTokenService({
  signingKeys,
  issuer,
  audience,
  accessTokenTtlSeconds,
  now = Date.now,
}) {
  const currentKid = keyId(signingKeys.publicKey);
  const verificationKeys = new Map([[currentKid, signingKeys.publicKey]]);
  for (const key of signingKeys.previousPublicKeys) verificationKeys.set(keyId(key), key);

  async function issueAccessToken({ userId, sessionId }) {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + accessTokenTtlSeconds;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: ALGORITHM, kid: currentKid, typ: ACCESS_TOKEN_TYPE })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(userId)
      .setJti(newId())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKeys.privateKey);
    return { token, expiresIn: accessTokenTtlSeconds, expiresAt: new Date(expiresAt * 1000) };
  }

  /** @returns {Promise<{ userId: string, sessionId: string }>} */
  async function verifyAccessToken(token) {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid && verificationKeys.get(header.kid);
          if (!key) throw new TokenError('token_invalid');
          return key;
        },
        {
          issuer,
          audience,
          algorithms: [ALGORITHM],
          typ: ACCESS_TOKEN_TYPE,
          requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
          currentDate: new Date(now()),
          clockTolerance: 5,
        },
      );
      if (typeof payload.sid !== 'string') throw new TokenError('token_invalid');
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new TokenError('token_expired');
      throw new TokenError('token_invalid');
    }
  }

  return { issueAccessToken, verifyAccessToken, keyId: currentKid };
}
