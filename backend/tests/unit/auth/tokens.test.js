import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignJWT, UnsecuredJWT } from 'jose';
import { createTokenService, keyId, TokenError } from '../../../src/core/auth/tokens.js';

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, previousPublicKeys: [] };
};

const service = (overrides = {}) =>
  createTokenService({
    signingKeys: keys(),
    issuer: 'healthbridge-api',
    audience: 'healthbridge-app',
    accessTokenTtlSeconds: 600,
    ...overrides,
  });

const ids = {
  userId: '0192b6f0-0000-7000-8000-000000000001',
  sessionId: '0192b6f0-0000-7000-8000-000000000002',
};

describe('access tokens', () => {
  it('issues a verifiable EdDSA token carrying only identifiers', async () => {
    const tokens = service();
    const { token, expiresIn } = await tokens.issueAccessToken(ids);
    expect(expiresIn).toBe(600);
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual(ids);

    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, 'base64url')));
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'at+jwt', kid: tokens.keyId });
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
  });

  it('rejects expired tokens with token_expired', async () => {
    const signingKeys = keys();
    const past = Date.now() - 3_600_000;
    const issuer = service({ signingKeys, now: () => past });
    const { token } = await issuer.issueAccessToken(ids);
    await expect(service({ signingKeys }).verifyAccessToken(token)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('rejects tokens signed by a different key', async () => {
    const { token } = await service().issueAccessToken(ids);
    await expect(service().verifyAccessToken(token)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects tampered tokens', async () => {
    const tokens = service();
    const { token } = await tokens.issueAccessToken(ids);
    const [h, p, s] = token.split('.');
    const forged = JSON.parse(Buffer.from(p, 'base64url'));
    forged.sub = '0192b6f0-0000-7000-8000-00000000ffff';
    const tampered = [h, Buffer.from(JSON.stringify(forged)).toString('base64url'), s].join('.');
    await expect(tokens.verifyAccessToken(tampered)).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('rejects unsigned (alg=none) tokens', async () => {
    const unsigned = new UnsecuredJWT({ sid: ids.sessionId })
      .setSubject(ids.userId)
      .setIssuer('healthbridge-api')
      .setAudience('healthbridge-app')
      .setIssuedAt()
      .setExpirationTime('5m')
      .encode();
    await expect(service().verifyAccessToken(unsigned)).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });

  it('rejects correctly signed JWTs that are not access tokens (typ) or lack claims', async () => {
    const signingKeys = keys();
    const tokens = service({ signingKeys });
    const kid = keyId(signingKeys.publicKey);
    const wrongType = await new SignJWT({ sid: ids.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
      .setSubject(ids.userId)
      .setIssuer('healthbridge-api')
      .setAudience('healthbridge-app')
      .setJti('x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKeys.privateKey);
    await expect(tokens.verifyAccessToken(wrongType)).rejects.toBeInstanceOf(TokenError);

    const noSession = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'at+jwt' })
      .setSubject(ids.userId)
      .setIssuer('healthbridge-api')
      .setAudience('healthbridge-app')
      .setJti('x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKeys.privateKey);
    await expect(tokens.verifyAccessToken(noSession)).rejects.toBeInstanceOf(TokenError);
  });

  it('rejects tokens for another audience', async () => {
    const signingKeys = keys();
    const { token } = await service({ signingKeys, audience: 'other-app' }).issueAccessToken(ids);
    await expect(service({ signingKeys }).verifyAccessToken(token)).rejects.toBeInstanceOf(
      TokenError,
    );
  });

  it('accepts tokens signed with a previous key during rotation', async () => {
    const old = keys();
    const { token } = await service({ signingKeys: old }).issueAccessToken(ids);
    const rotated = { ...keys(), previousPublicKeys: [old.publicKey] };
    await expect(service({ signingKeys: rotated }).verifyAccessToken(token)).resolves.toEqual(ids);
  });
});
