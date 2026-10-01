import { describe, expect, it } from 'vitest';
import { createAccessPolicy } from '../../../src/core/authz/accessPolicy.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../../../src/core/http/errors.js';

function fakeAudit() {
  const events = [];
  return {
    events,
    record: async (event) => events.push({ ...event, mode: 'strict' }),
    recordBestEffort: async (event) => events.push({ ...event, mode: 'best_effort' }),
  };
}

const principal = (permissions, userId = 'user-1') => ({
  userId,
  sessionId: 'session-1',
  roles: ['DOCTOR'],
  permissions: new Set(permissions),
});

const PATIENT_ID = '0192b6f0-0000-7000-8000-0000000000aa';

function policy({ relationship, consent } = {}) {
  const audit = fakeAudit();
  const accessPolicy = createAccessPolicy({
    audit,
    relationshipResolvers: {
      patient_record: () => relationship ?? { related: false },
      broken: () => {
        throw new Error('db down');
      },
    },
    consentResolver: async () => consent ?? null,
  });
  return { audit, accessPolicy };
}

const record = { type: 'patient_record', id: 'rec-1', patientId: PATIENT_ID };

describe('AccessPolicy: three gates', () => {
  it('requires a principal', async () => {
    const { accessPolicy } = policy();
    await expect(
      accessPolicy.enforce({ principal: null, permission: 'x:y' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('gate 1: denies without the permission (403) and audits the denial', async () => {
    const { accessPolicy, audit } = policy();
    await expect(
      accessPolicy.enforce({ principal: principal([]), permission: 'medical_records:read' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(audit.events).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        action: 'medical_records:read',
        reason: 'permission:missing_permission',
        mode: 'best_effort',
      }),
    ]);
  });

  it('authentication alone never grants patient data: gate 2 denies unrelated users (404)', async () => {
    const { accessPolicy, audit } = policy({ relationship: { related: false } });
    await expect(
      accessPolicy.enforce({
        principal: principal(['medical_records:read']),
        permission: 'medical_records:read',
        resource: record,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events[0]).toMatchObject({
      category: 'data_access',
      outcome: 'denied',
      patientId: PATIENT_ID,
      reason: 'relationship:not_related',
    });
  });

  it('gate 3: a related doctor without active consent is denied (consent_required)', async () => {
    const { accessPolicy } = policy({
      relationship: { related: true, relationship: 'treating_doctor' },
    });
    await expect(
      accessPolicy.enforce({
        principal: principal(['medical_records:read']),
        permission: 'medical_records:read',
        resource: record,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'consent_required' });
  });

  it('allows when all three gates pass and audits the patient-data access strictly', async () => {
    const { accessPolicy, audit } = policy({
      relationship: { related: true, relationship: 'treating_doctor' },
      consent: { consentId: 'consent-1' },
    });
    const decision = await accessPolicy.enforce({
      principal: principal(['medical_records:read']),
      permission: 'medical_records:read',
      resource: record,
      purpose: 'consultation',
    });
    expect(decision).toMatchObject({ allowed: true, consentId: 'consent-1' });
    expect(audit.events[0]).toMatchObject({
      category: 'data_access',
      outcome: 'success',
      mode: 'strict',
      metadata: { purpose: 'consultation', consentId: 'consent-1' },
    });
  });

  it('the patient (self) needs no consent for their own data', async () => {
    const { accessPolicy } = policy({ relationship: { related: true, relationship: 'self' } });
    await expect(
      accessPolicy.evaluate({
        principal: principal(['medical_records:read']),
        permission: 'medical_records:read',
        resource: record,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('fails closed for unknown resource types and resolver errors', async () => {
    const { accessPolicy } = policy();
    const p = principal(['x:y']);
    await expect(
      accessPolicy.evaluate({ principal: p, permission: 'x:y', resource: { type: 'unknown' } }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no_relationship_resolver' });
    await expect(
      accessPolicy.evaluate({ principal: p, permission: 'x:y', resource: { type: 'broken' } }),
    ).resolves.toMatchObject({ allowed: false, reason: 'resolver_error' });
  });

  it('does not audit allowed non-patient checks (noise) but does audit denials', async () => {
    const { accessPolicy, audit } = policy();
    await accessPolicy.enforce({ principal: principal(['users:read']), permission: 'users:read' });
    expect(audit.events).toHaveLength(0);
  });
});
