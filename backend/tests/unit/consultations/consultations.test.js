import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import {
  consultationOutcomeSchema,
  prescriptionDraftSchema,
  soapNoteSchema,
} from '@healthbridge/shared';
import { appointmentTransition } from '../../../src/modules/scheduling/domain/appointmentStateMachine.js';
import { ConfigError, loadConfig } from '../../../src/config/index.js';
import { ConflictError, ForbiddenError } from '../../../src/core/http/errors.js';
import { createEnvelope } from '../../../src/core/crypto/envelope.js';
import { renderTextPdf } from '../../../src/core/pdf/textPdf.js';
import { checkPrescribingRules } from '../../../src/modules/consultations/prescribingRules.js';
import { createVideoProvider } from '../../../src/modules/consultations/videoProvider.js';
import {
  canonicalContent,
  newPrescriptionReference,
} from '../../../src/modules/consultations/prescriptions.js';
import { renderTemplate } from '../../../src/modules/notifications/templates.js';
import { validEnv } from '../../helpers.js';

const at = (iso) => new Date(iso);
// 09:30–09:45 IST on Monday 2026-10-05.
const appt = (overrides = {}) => ({
  status: 'confirmed',
  mode: 'online',
  starts_at: at('2026-10-05T04:00:00Z'),
  ends_at: at('2026-10-05T04:15:00Z'),
  hold_expires_at: null,
  ...overrides,
});

describe('consultation lifecycle', () => {
  it('starts an online consultation from 10 minutes before until an hour after the end', () => {
    expect(
      appointmentTransition(appt(), 'start_consultation', 'doctor', at('2026-10-05T03:52:00Z')),
    ).toBe('in_consultation');
    expect(() =>
      appointmentTransition(appt(), 'start_consultation', 'doctor', at('2026-10-05T03:40:00Z')),
    ).toThrow(ConflictError);
    expect(() =>
      appointmentTransition(appt(), 'start_consultation', 'doctor', at('2026-10-05T05:20:00Z')),
    ).toThrow(ConflictError);
    expect(() =>
      appointmentTransition(appt(), 'start_consultation', 'patient', at('2026-10-05T04:00:00Z')),
    ).toThrow(ForbiddenError);
  });

  it('starts an in-clinic consultation only after check-in', () => {
    const now = at('2026-10-05T04:01:00Z');
    expect(() =>
      appointmentTransition(appt({ mode: 'in_clinic' }), 'start_consultation', 'doctor', now),
    ).toThrow(ConflictError);
    expect(
      appointmentTransition(
        appt({ mode: 'in_clinic', status: 'checked_in' }),
        'start_consultation',
        'doctor',
        now,
      ),
    ).toBe('in_consultation');
  });

  it('completes a live consultation only through the outcome', () => {
    const live = appt({ status: 'in_consultation' });
    const now = at('2026-10-05T04:10:00Z');
    expect(() => appointmentTransition(live, 'complete', 'doctor', now)).toThrow(ConflictError);
    expect(appointmentTransition(live, 'finish_consultation', 'doctor', now)).toBe('completed');
    expect(() => appointmentTransition(live, 'finish_consultation', 'clinic', now)).toThrow(
      ForbiddenError,
    );
  });
});

describe('clinical data envelope', () => {
  const keyring = (currentKeyId, entries) => ({ currentKeyId, keys: new Map(entries) });
  const k1 = Buffer.alloc(32, 1);
  const k2 = Buffer.alloc(32, 2);

  it('round-trips, binds associated data and detects tampering', () => {
    const env = createEnvelope(keyring('k1', [['k1', k1]]));
    const note = { subjective: 'Synthetic cough for 3 days', plan: 'Rest' };
    const { keyId, blob } = env.encryptJson(note, 'clinical_note:a:p');
    expect(keyId).toBe('k1');
    expect(blob.includes(Buffer.from('Synthetic'))).toBe(false);
    expect(env.decryptJson(blob, 'clinical_note:a:p')).toEqual(note);
    expect(() => env.decryptJson(blob, 'clinical_note:b:p')).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    expect(() => env.decryptJson(tampered, 'clinical_note:a:p')).toThrow();
  });

  it('reads records sealed under a previous key after rotation', () => {
    const old = createEnvelope(keyring('k1', [['k1', k1]]));
    const { blob } = old.encryptJson({ plan: 'x' }, 'aad');
    const rotated = createEnvelope(
      keyring('k2', [
        ['k2', k2],
        ['k1', k1],
      ]),
    );
    expect(rotated.decryptJson(blob, 'aad')).toEqual({ plan: 'x' });
    expect(rotated.encryptJson({ plan: 'y' }, 'aad').keyId).toBe('k2');
    expect(() => createEnvelope(keyring('k2', [['k2', k2]])).decryptJson(blob, 'aad')).toThrow(
      /not configured/,
    );
  });
});

describe('prescription PDF', () => {
  it('is deterministic, escapes text and breaks pages', () => {
    const blocks = [
      { text: 'Prescription (synthetic)', bold: true, size: 18 },
      ...Array.from({ length: 80 }, (_, i) => ({ text: `${i + 1}. Paracetamol 500 mg` })),
    ];
    const a = renderTextPdf(blocks, { footer: 'RX-TEST' });
    const b = renderTextPdf(blocks, { footer: 'RX-TEST' });
    expect(a.equals(b)).toBe(true);
    const text = a.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Prescription \\(synthetic\\)');
    expect(text).toMatch(/\/Count [2-9]/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('canonical content is order-stable and changes with any field', () => {
    const row = {
      reference: 'RX-ABCDEFGHJK',
      version: 1,
      patient_id: 'p',
      doctor_id: 'd',
      appointment_id: 'a',
      advice: 'Drink fluids',
    };
    const item = (position, drug) => ({
      position,
      drug_name: drug,
      strength: '500 mg',
      form: 'tablet',
      dose: '1 tablet',
      frequency: 'twice a day',
      route: 'oral',
      duration: '3 days',
      instructions: '',
    });
    const signedAt = '2026-10-05T04:10:00.000Z';
    const one = canonicalContent(row, [item(2, 'B'), item(1, 'A')], signedAt);
    expect(one).toBe(canonicalContent(row, [item(1, 'A'), item(2, 'B')], signedAt));
    expect(one).not.toBe(canonicalContent({ ...row, advice: '' }, [item(1, 'A')], signedAt));
    expect(newPrescriptionReference()).toMatch(/^RX-[0-9A-Z]{10}$/);
  });
});

describe('prescribing rules', () => {
  const item = (drugName, strength = '') => ({ drugName, strength });

  it('blocks prohibited substances online, not in clinic', () => {
    const online = checkPrescribingRules([item('Tramadol 50 mg')], { mode: 'online' });
    expect(online).toEqual([expect.objectContaining({ code: 'prohibited_in_teleconsultation' })]);
    expect(checkPrescribingRules([item('Tramadol')], { mode: 'in_clinic' })).toEqual([]);
    expect(checkPrescribingRules([item('Paracetamol')], { mode: 'online' })).toEqual([]);
  });

  it('flags duplicate items', () => {
    const v = checkPrescribingRules([item('Cetirizine', '10 mg'), item('cetirizine', '10 mg')], {
      mode: 'online',
    });
    expect(v).toEqual([expect.objectContaining({ position: 2, code: 'duplicate_item' })]);
  });
});

describe('video provider', () => {
  const base = { tokenTtlSeconds: 600, mockSecret: 'x'.repeat(48) };

  it('mock: random rooms, opaque identities, short expiry', async () => {
    const video = createVideoProvider({ ...base, provider: 'mock' });
    const room = video.newRoom();
    expect(room).toMatch(/^hb-[A-Za-z0-9_-]{16}$/);
    expect(video.newRoom()).not.toBe(room);
    const grant = await video.joinGrant({
      room,
      identity: 'c1:u1',
      displayName: 'Patient',
      role: 'patient',
    });
    const claims = decodeJwt(grant.token);
    expect(claims.sub).not.toContain('u1');
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
    expect(grant.url).toBeNull();
  });

  it('livekit: a video grant for exactly one room', async () => {
    const video = createVideoProvider({
      ...base,
      provider: 'livekit',
      livekit: { url: 'wss://lk.test', apiKey: 'key', apiSecret: 's'.repeat(32) },
    });
    const grant = await video.joinGrant({
      room: 'hb-room',
      identity: 'c1:u2',
      displayName: 'Dr Test',
      role: 'doctor',
    });
    const claims = decodeJwt(grant.token);
    expect(claims.iss).toBe('key');
    expect(claims.video).toMatchObject({ room: 'hb-room', roomJoin: true, roomAdmin: true });
    expect(grant.url).toBe('wss://lk.test');
  });
});

describe('M9 configuration', () => {
  const issues = (env) => {
    try {
      loadConfig({ ...validEnv, ...env });
      return [];
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return err.issues.map((i) => i.variable);
    }
  };

  it('derives a stable development key; requires a real one in staging', () => {
    const a = loadConfig(validEnv).clinicalData;
    const b = loadConfig(validEnv).clinicalData;
    expect(a.keys.get('k1').equals(b.keys.get('k1'))).toBe(true);
    expect(issues({ APP_ENV: 'staging' })).toContain('CLINICAL_DATA_KEY');
    expect(issues({ CLINICAL_DATA_KEY: Buffer.alloc(16).toString('base64') })).toContain(
      'CLINICAL_DATA_KEY',
    );
    expect(
      issues({ CLINICAL_DATA_PREVIOUS_KEYS: 'old:notbase64' }).length +
        issues({ CLINICAL_DATA_PREVIOUS_KEYS: `old:${Buffer.alloc(32).toString('base64')}` })
          .length,
    ).toBe(1);
  });

  it('requires LiveKit credentials when selected', () => {
    expect(issues({ VIDEO_PROVIDER: 'livekit' })).toEqual(
      expect.arrayContaining(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']),
    );
  });
});

describe('M9 schemas and notices', () => {
  it('validates notes, prescriptions and outcomes', () => {
    expect(soapNoteSchema.safeParse({}).success).toBe(false);
    expect(soapNoteSchema.safeParse({ assessment: 'Viral fever (synthetic)' }).success).toBe(true);
    expect(
      prescriptionDraftSchema.safeParse({
        items: [
          { drugName: 'Paracetamol', dose: '1 tablet', frequency: 'SOS', duration: '3 days' },
        ],
      }).success,
    ).toBe(true);
    expect(prescriptionDraftSchema.safeParse({ items: [] }).success).toBe(false);
    expect(consultationOutcomeSchema.safeParse({ outcome: 'emergency_escalation' }).success).toBe(
      false,
    );
    expect(
      consultationOutcomeSchema.safeParse({ outcome: 'emergency_escalation', confirm: true })
        .success,
    ).toBe(true);
    expect(
      consultationOutcomeSchema.safeParse({ outcome: 'online_managed', followUpOn: '2026-10-12' })
        .success,
    ).toBe(true);
  });

  it('notices never contain clinical content', () => {
    const vars = {
      recipientName: 'Asha',
      patientName: 'Asha',
      relationship: 'self',
      doctorName: 'Dr. Meera',
      clinicName: null,
      mode: 'online',
      startsAt: new Date('2026-10-05T04:00:00Z'),
      timezone: 'Asia/Kolkata',
      reference: 'ABCD1234',
    };
    const rx = renderTemplate('prescription_available', vars);
    expect(rx.subject).toBe('New prescription from Dr. Meera');
    expect(rx.text).not.toMatch(/mg|tablet|diagnos/i);
    expect(renderTemplate('emergency_guidance', vars).text).toContain('112');
  });
});
