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
