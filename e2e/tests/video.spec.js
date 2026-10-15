import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, demoEmail, signIn } from './helpers.js';

/**
 * Live video consultation over a real LiveKit server (`npm start -- --video`), with
 * Chromium's synthetic camera and microphone. Opt-in (E2E_VIDEO=1, local Compose stack):
 * bookings need 30 minutes' notice and consultations start at most 10 minutes early, so
 * the test books normally through the API and then moves that one synthetic booking to
 * start in 5 minutes directly in the local database. Synthetic accounts only.
 */
test.skip(process.env.E2E_VIDEO !== '1', 'set E2E_VIDEO=1 with the stack started with --video');
test.setTimeout(12 * 60_000);

const pad = (n) => String(n).padStart(2, '0');

test('doctor and patient see and hear each other in a live consultation @video', async ({
  browser,
  request,
}) => {
  const api = async (method, path, token, data) => {
    const res = await request.fetch(`/api/v1${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      data,
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
  };
  const login = async (local) =>
    (await api('POST', '/auth/login', null, { email: demoEmail(local), password: DEMO_PASSWORD }))
      .body.data.accessToken;
  const [asha, meera] = [await login('patient.asha'), await login('dr.meera')];
  const patientId = (await api('GET', '/patients/me', asha)).body.data.id;
  const doctorId = (await api('GET', '/doctors/me', meera)).body.data.id;

  // Temporary online hours today (IST) from the current quarter hour (409 on re-runs).
  const ist = new Date(Date.now() + 330 * 60_000);
  const today = ist.toISOString().slice(0, 10);
  const start = `${pad(ist.getUTCHours())}:${pad(Math.floor(ist.getUTCMinutes() / 15) * 15)}`;
  const end = `${pad(Math.min(ist.getUTCHours() + 2, 23))}:${start.slice(3)}`;
  await api('POST', '/doctors/me/availability', meera, {
    mode: 'online',
    weekday: ist.getUTCDay() === 0 ? 7 : ist.getUTCDay(),
    startTime: start,
    endTime: end,
    slotMinutes: 15,
    validFrom: today,
    validUntil: today,
  });
  // Earlier runs: the patient cancels leftover test bookings with this doctor (real API).
  const upcoming = (await api('GET', '/appointments?scope=upcoming', asha)).body.data ?? [];
  for (const a of upcoming.filter((x) => x.doctorId === doctorId && x.status === 'confirmed')) {
    await api('POST', `/appointments/${a.id}/cancel`, asha, { reasonCode: 'patient_request' });
  }
  const tomorrow = new Date(ist.getTime() + 86_400_000).toISOString().slice(0, 10);
  const slots = await api(
    'GET',
    `/doctors/${doctorId}/slots?from=${today}&to=${tomorrow}&mode=online`,
    asha,
  );
  const slot = slots.body.data.find((s) => new Date(s.startsAt).getTime() > Date.now() + 60_000);
  expect(slot, 'an online slot later today').toBeTruthy();
  const booked = await api('POST', '/appointments', asha, {
    patientId,
    doctorId,
    startsAt: slot.startsAt,
    mode: 'online',
    reason: 'Synthetic: video consultation test',
  });
  expect(booked.status).toBe(201);
  const appointmentId = booked.body.data.id;
  expect(appointmentId).toMatch(/^[0-9a-f-]{36}$/);
  const page = `/app/appointments/${appointmentId}/consultation`;

  // Test fixture (local stack only): move this synthetic booking to start in about five
  // minutes, after anything this doctor or patient still has running (e.g. an earlier run).
  const sql = `
    WITH me AS (SELECT doctor_id, patient_id FROM appointments WHERE id = '${appointmentId}'),
    busy AS (
      SELECT max(a.ends_at) AS until FROM appointments a, me
       WHERE a.id <> '${appointmentId}' AND a.ends_at > now() AND a.starts_at < now() + interval '1 hour'
         AND a.status IN ('pending_payment', 'confirmed', 'checked_in', 'in_consultation')
         AND (a.doctor_id = me.doctor_id OR a.patient_id = me.patient_id)),
    t AS (SELECT greatest(date_trunc('minute', now()) + interval '5 minutes',
                          coalesce((SELECT until FROM busy), now())) AS s)
    UPDATE appointments SET starts_at = t.s, ends_at = t.s + interval '15 minutes'
      FROM t WHERE id = '${appointmentId}' RETURNING starts_at`;
  const moved = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      process.env.POSTGRES_USER,
      '-d',
      process.env.POSTGRES_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      sql,
    ],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' },
  );
  // psql prints e.g. "2026-10-03 13:50:00+00" (then "UPDATE 1").
  const startsAt = new Date(moved.trim().split(/\r?\n/)[0].replace(' ', 'T').replace(/\+00$/, 'Z'));
  // The doctor may start from 10 minutes before the booked time.
  const wait = startsAt.getTime() - 10 * 60_000 - Date.now() + 2_000;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  const media = {
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
  };
  const patientCtx = await browser.newContext(media);
  const doctorCtx = await browser.newContext(media);
  const patient = await patientCtx.newPage();
  const doctor = await doctorCtx.newPage();
  await signIn(patient, demoEmail('patient.asha'));
  await patient.goto(page);
  await signIn(doctor, demoEmail('dr.meera'));
  await doctor.goto(page);

  await doctor.getByRole('button', { name: 'Start consultation' }).click();
  await doctor.getByRole('button', { name: 'Join video' }).click();
  await expect(patient.getByRole('button', { name: 'Join video' })).toBeVisible({
    timeout: 60_000,
  });
  await patient.getByRole('button', { name: 'Join video' }).click();

  // Each side receives the other's live video track from the LiveKit server.
  for (const p of [doctor, patient]) {
    await expect(p.locator('video[data-remote="video"]')).toBeVisible({ timeout: 45_000 });
    await expect
      .poll(() => p.locator('video[data-remote="video"]').evaluate((v) => v.videoWidth), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  }

  await patient.getByRole('button', { name: 'Leave call' }).click();
  await patientCtx.close();
  await doctorCtx.close();
});
