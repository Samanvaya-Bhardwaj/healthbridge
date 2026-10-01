import { parse } from 'cookie';
import { API_BASE_PATH, CSRF_COOKIE } from '@healthbridge/shared';

/** httpOnly refresh-token cookie, scoped to the auth endpoints only. */
export const REFRESH_COOKIE = 'hb_refresh';
export const REFRESH_COOKIE_PATH = `${API_BASE_PATH}/auth`;

export const readCookies = (req) => parse(req.headers.cookie ?? '');

/**
 * @param {import('express').Response} res
 * @param {{ refreshToken: string, csrfToken: string, maxAgeSeconds: number, secure: boolean }} options
 */
export function setSessionCookies(res, { refreshToken, csrfToken, maxAgeSeconds, secure }) {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds)) * 1000;
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge,
  });
  // Readable by the SPA so it can echo the value in the X-CSRF-Token header.
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookies(res, { secure }) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, secure, sameSite: 'strict', path: '/' });
}
