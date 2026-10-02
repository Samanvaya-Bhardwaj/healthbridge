import { apiRequest } from './apiClient.js';

const data = async (promise) => (await promise)?.data;
const qs = (params) => {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

/** API calls for the M2 domain (patients, doctors, clinics, care relationships). */
export const patientsApi = {
  me: () => data(apiRequest('/patients/me')),
  createMe: (body) => data(apiRequest('/patients/me', { method: 'POST', body })),
  updateMe: (body) => data(apiRequest('/patients/me', { method: 'PATCH', body })),
  dependents: () => data(apiRequest('/patients/me/dependents')),
  createDependent: (body) => data(apiRequest('/patients/me/dependents', { method: 'POST', body })),
  endGuardianship: (id) => data(apiRequest(`/guardianships/${id}/end`, { method: 'POST' })),
};

export const doctorsApi = {
  me: () => data(apiRequest('/doctors/me')),
  createMe: (body) => data(apiRequest('/doctors/me', { method: 'POST', body })),
  updateMe: (body) => data(apiRequest('/doctors/me', { method: 'PATCH', body })),
  submitVerification: () => data(apiRequest('/doctors/me/verification', { method: 'POST' })),
  verificationHistory: () => data(apiRequest('/doctors/me/verification')),
  myClinics: () => data(apiRequest('/doctors/me/clinics')),
  directory: (params = {}) => apiRequest(`/doctors${qs({ limit: 20, ...params })}`),
  myPatients: (status) => data(apiRequest(`/doctors/me/patients${qs({ status })}`)),
  publicProfile: (id) => data(apiRequest(`/doctors/${id}`)),
};

export const careApi = {
  list: (patientId) => data(apiRequest(`/care-relationships${qs({ patientId })}`)),
  request: (body) => data(apiRequest('/care-relationships', { method: 'POST', body })),
  invite: (body) => data(apiRequest('/care-relationships/invitations', { method: 'POST', body })),
  act: (id, action) => data(apiRequest(`/care-relationships/${id}/${action}`, { method: 'POST' })),
};

export const clinicsApi = {
  get: (id) => data(apiRequest(`/clinics/${id}`)),
  members: (id) => data(apiRequest(`/clinics/${id}/members`)),
  inviteDoctor: (id, doctorId) =>
    data(apiRequest(`/clinics/${id}/doctors`, { method: 'POST', body: { doctorId } })),
  endMembership: (clinicId, membershipId) =>
    data(apiRequest(`/clinics/${clinicId}/members/${membershipId}/end`, { method: 'POST' })),
  respond: (membershipId, action) =>
    data(apiRequest(`/clinic-memberships/${membershipId}/${action}`, { method: 'POST' })),
};

export const adminApi = {
  verificationQueue: (status) => data(apiRequest(`/admin/doctor-verifications${qs({ status })}`)),
  startReview: (id) =>
    data(apiRequest(`/admin/doctor-verifications/${id}/start-review`, { method: 'POST' })),
  decide: (id, body) =>
    data(apiRequest(`/admin/doctor-verifications/${id}/decision`, { method: 'POST', body })),
  clinics: () => data(apiRequest('/admin/clinics?limit=100')),
  createClinic: (body) => data(apiRequest('/admin/clinics', { method: 'POST', body })),
  appointClinicAdmin: (clinicId, userId) =>
    data(apiRequest(`/admin/clinics/${clinicId}/admins`, { method: 'POST', body: { userId } })),
  findUsers: (q) => data(apiRequest(`/admin/users${qs({ q, limit: 5 })}`)),
};

export const schedulingApi = {
  slots: (doctorId, params) => data(apiRequest(`/doctors/${doctorId}/slots${qs(params)}`)),
  book: (body, idempotencyKey) =>
    data(
      apiRequest('/appointments', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    ),
  mine: (params = {}) => data(apiRequest(`/appointments${qs(params)}`)),
  get: (id) => data(apiRequest(`/appointments/${id}`)),
  cancel: (id, reasonCode) =>
    data(apiRequest(`/appointments/${id}/cancel`, { method: 'POST', body: { reasonCode } })),
  reschedule: (id, startsAt) =>
    data(apiRequest(`/appointments/${id}/reschedule`, { method: 'POST', body: { startsAt } })),
  action: (id, action) => data(apiRequest(`/appointments/${id}/${action}`, { method: 'POST' })),
  doctorSchedule: (from, to) => data(apiRequest(`/doctors/me/appointments${qs({ from, to })}`)),
  clinicSchedule: (clinicId, from, to) =>
    data(apiRequest(`/clinics/${clinicId}/appointments${qs({ from, to })}`)),
  rules: () => data(apiRequest('/doctors/me/availability')),
  addRule: (body) => data(apiRequest('/doctors/me/availability', { method: 'POST', body })),
  archiveRule: (id) => apiRequest(`/doctors/me/availability/${id}`, { method: 'DELETE' }),
  timeOff: () => data(apiRequest('/doctors/me/time-off')),
  addTimeOff: (body) => data(apiRequest('/doctors/me/time-off', { method: 'POST', body })),
  removeTimeOff: (id) => apiRequest(`/doctors/me/time-off/${id}`, { method: 'DELETE' }),
};

/**
 * Payments (M4). The browser only starts a checkout and reads status: a payment becomes
 * "paid" solely through the provider's verified webhook on the server.
 */
export const paymentsApi = {
  checkout: (appointmentId) =>
    data(apiRequest(`/appointments/${appointmentId}/payment`, { method: 'POST', body: {} })),
  get: (appointmentId) => data(apiRequest(`/appointments/${appointmentId}/payment`)),
  /** Development/test only (fake provider): asks the server to emit a signed test webhook. */
  simulate: (appointmentId, outcome) =>
    data(
      apiRequest(`/appointments/${appointmentId}/payment/simulate`, {
        method: 'POST',
        body: { outcome },
      }),
    ),
};
