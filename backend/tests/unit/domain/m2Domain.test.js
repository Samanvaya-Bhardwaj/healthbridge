import { describe, expect, it } from 'vitest';
import { careTransition } from '../../../src/modules/care/domain/stateMachine.js';
import { nextVerificationStatus } from '../../../src/modules/doctors/domain/verification.js';
import { buildPrincipal, hasPermission, principalView } from '../../../src/core/authz/principal.js';
import { createAccessPolicy } from '../../../src/core/authz/accessPolicy.js';
import { ConflictError, ForbiddenError } from '../../../src/core/http/errors.js';

describe('care relationship state machine', () => {
  it.each([
    ['pending', 'accept', 'doctor', 'active'],
    ['invited', 'accept', 'patient', 'active'],
    ['pending', 'decline', 'doctor', 'ended'],
    ['pending', 'withdraw', 'patient', 'ended'],
    ['active', 'pause', 'patient', 'paused'],
    ['paused', 'resume', 'patient', 'active'],
    ['active', 'end', 'doctor', 'ended'],
    ['paused', 'end', 'patient', 'ended'],
  ])('%s --%s(%s)--> %s', (from, action, party, to) => {
    expect(careTransition(from, action, party).to).toBe(to);
  });

  it('records why a relationship ended', () => {
    expect(careTransition('active', 'end', 'patient').endReason).toBe('patient_ended');
    expect(careTransition('invited', 'decline', 'patient').endReason).toBe('declined');
  });

  it.each([
    ['pending', 'accept', 'patient'], // initiator cannot accept own request
    ['invited', 'accept', 'doctor'],
    ['active', 'pause', 'doctor'], // only the patient pauses access to themself
  ])('rejects %s/%s by the %s', (from, action, party) => {
    expect(() => careTransition(from, action, party)).toThrow(ForbiddenError);
  });

  it.each([
    ['ended', 'resume'],
    ['ended', 'accept'],
    ['active', 'accept'],
    ['pending', 'pause'],
  ])('rejects invalid transition %s/%s', (from, action) => {
    expect(() => careTransition(from, action, 'patient')).toThrow(ConflictError);
  });
});

describe('doctor verification state machine', () => {
  it('follows submit → review → verify/reject, and suspend → resubmit', () => {
    expect(nextVerificationStatus('unverified', 'submit')).toBe('pending');
    expect(nextVerificationStatus('pending', 'start_review')).toBe('under_review');
    expect(nextVerificationStatus('under_review', 'verify')).toBe('verified');
    expect(nextVerificationStatus('under_review', 'reject')).toBe('rejected');
    expect(nextVerificationStatus('rejected', 'submit')).toBe('pending');
    expect(nextVerificationStatus('verified', 'suspend')).toBe('suspended');
    expect(nextVerificationStatus('suspended', 'submit')).toBe('pending');
  });

  it.each([
    ['unverified', 'verify'],
    ['pending', 'verify'], // no decision without review
    ['verified', 'submit'],
    ['under_review', 'suspend'],
  ])('rejects %s --%s', (from, action) => {
    expect(() => nextVerificationStatus(from, action)).toThrow(ConflictError);
  });
});

describe('clinic-scoped principals', () => {
  const CLINIC_A = '0192b6f0-0000-7000-8000-00000000000a';
  const CLINIC_B = '0192b6f0-0000-7000-8000-00000000000b';
  const principal = buildPrincipal({
    userId: 'u1',
    sessionId: 's1',
    email: 'x@test',
    fullName: 'X',
    roleGrants: [{ role: 'CLINIC_ADMIN', clinicId: CLINIC_A }],
    permissionGrants: [
      { permission: 'clinic:manage', clinicId: CLINIC_A },
      { permission: 'account:read', clinicId: CLINIC_A },
    ],
  });

  it('keeps clinic permissions scoped, but account-level permissions global', () => {
    expect(hasPermission(principal, 'clinic:manage', CLINIC_A)).toBe(true);
    expect(hasPermission(principal, 'clinic:manage', CLINIC_B)).toBe(false);
    expect(hasPermission(principal, 'clinic:manage')).toBe(false);
    expect(hasPermission(principal, 'account:read')).toBe(true);
    expect(principalView(principal)).toMatchObject({
      roles: ['CLINIC_ADMIN'],
      permissions: ['account:read'],
      clinicPermissions: { [CLINIC_A]: ['clinic:manage'] },
    });
  });

  it('AccessPolicy gate 1 honours the clinic in scope', async () => {
    const audit = { record: async () => {}, recordBestEffort: async () => {} };
    const policy = createAccessPolicy({ audit });
    await expect(
      policy.evaluate({ principal, permission: 'clinic:manage', clinicId: CLINIC_A }),
    ).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      policy.evaluate({ principal, permission: 'clinic:manage', clinicId: CLINIC_B }),
    ).resolves.toMatchObject({
      allowed: false,
      gate: 'permission',
    });
  });
});
