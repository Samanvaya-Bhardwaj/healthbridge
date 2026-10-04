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
  // M11: user administration, audit trail and operations (paged calls return { data, meta }).
  users: (params = {}) => apiRequest(`/admin/users${qs({ limit: 25, ...params })}`),
  user: (id) => data(apiRequest(`/admin/users/${id}`)),
  setUserStatus: (id, body) =>
    data(apiRequest(`/admin/users/${id}/status`, { method: 'PATCH', body })),
  grantRole: (id, role) => data(apiRequest(`/admin/users/${id}/roles/${role}`, { method: 'PUT' })),
  revokeRole: (id, role) =>
    data(apiRequest(`/admin/users/${id}/roles/${role}`, { method: 'DELETE' })),
  revokeSessions: (id) =>
    data(apiRequest(`/admin/users/${id}/sessions/revoke`, { method: 'POST' })),
  auditLogs: (params = {}) => apiRequest(`/admin/audit-logs${qs({ limit: 50, ...params })}`),
  operationsSummary: () => data(apiRequest('/admin/operations/summary')),
  deadLetters: (status) => data(apiRequest(`/admin/operations/dead-letters${qs({ status })}`)),
  retryDeadLetter: (id) =>
    data(apiRequest(`/admin/operations/dead-letters/${id}/retry`, { method: 'POST' })),
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
  /** Doctor or clinic: money back to the patient. The key makes retries safe. */
  refund: (appointmentId, body, idempotencyKey) =>
    data(
      apiRequest(`/appointments/${appointmentId}/refunds`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    ),
  /** Development/test only (fake provider): asks the server to emit a signed test webhook. */
  simulate: (appointmentId, outcome) =>
    data(
      apiRequest(`/appointments/${appointmentId}/payment/simulate`, {
        method: 'POST',
        body: { outcome },
      }),
    ),
};

/**
 * Medical records (M5). Metadata and short-lived signed URLs only; uploads go straight
 * to object storage with a presigned POST and are scanned before they become available.
 */
export const recordsApi = {
  list: (patientId) => data(apiRequest(`/patients/${patientId}/documents`)),
  uploadIntent: (patientId, body) =>
    data(apiRequest(`/patients/${patientId}/documents/upload-intent`, { method: 'POST', body })),
  complete: (id) => data(apiRequest(`/documents/${id}/complete`, { method: 'POST', body: {} })),
  download: (id) => data(apiRequest(`/documents/${id}/download`)),
  retire: (id) => data(apiRequest(`/documents/${id}/retire`, { method: 'POST', body: {} })),
};

export const consentsApi = {
  list: (patientId) => data(apiRequest(`/consents${qs({ patientId })}`)),
  received: () => data(apiRequest('/consents/received')),
  grant: (body) => data(apiRequest('/consents', { method: 'POST', body })),
  revoke: (id, reasonCode) =>
    data(apiRequest(`/consents/${id}/revoke`, { method: 'POST', body: { reasonCode } })),
  accessLog: (patientId, cursor) =>
    apiRequest(`/patients/${patientId}/access-log${qs({ cursor, limit: 30 })}`),
};

/** Document intelligence (M6): AI proposals are suggestions until a doctor verifies them. */
export const intelligenceApi = {
  extraction: (documentId) => data(apiRequest(`/documents/${documentId}/extraction`)),
  verify: (documentId, fieldKeys) =>
    data(
      apiRequest(`/documents/${documentId}/lab-results/verify`, {
        method: 'POST',
        body: { fieldKeys },
      }),
    ),
  labResults: (patientId) => data(apiRequest(`/patients/${patientId}/lab-results`)),
  aiProcessing: (patientId) => data(apiRequest(`/patients/${patientId}/ai-processing`)),
  setAiProcessing: (patientId, enabled) =>
    data(apiRequest(`/patients/${patientId}/ai-processing`, { method: 'PUT', body: { enabled } })),
};

/** Medical timeline (M7): a projection with provenance on every event. */
export const timelineApi = {
  list: (patientId, { cursor, types = [] } = {}) =>
    apiRequest(
      `/patients/${patientId}/timeline${qs({ cursor, limit: 30, types: types.length ? types.join(',') : undefined })}`,
    ),
  export: (patientId) => apiRequest(`/patients/${patientId}/timeline/export`),
};

/** AI assistance for treating doctors (M8): cited answers and briefs, never diagnoses. */
export const assistApi = {
  ask: (patientId, question) =>
    data(
      apiRequest(`/patients/${patientId}/record-questions`, { method: 'POST', body: { question } }),
    ),
  brief: (appointmentId, refresh) =>
    data(apiRequest(`/appointments/${appointmentId}/brief`, { method: 'POST', body: { refresh } })),
  feedback: (briefId, rating) =>
    data(apiRequest(`/briefs/${briefId}/feedback`, { method: 'POST', body: { rating } })),
};

/** Consultations and prescribing (M9). Clinical decisions are always the doctor's. */
export const consultationApi = {
  view: (appointmentId) => data(apiRequest(`/appointments/${appointmentId}/consultation`)),
  status: (appointmentId) => data(apiRequest(`/appointments/${appointmentId}/consultation/status`)),
  arrive: (appointmentId) =>
    data(apiRequest(`/appointments/${appointmentId}/waiting-room`, { method: 'POST' })),
  start: (appointmentId) =>
    data(apiRequest(`/appointments/${appointmentId}/consultation/start`, { method: 'POST' })),
  join: (appointmentId) =>
    data(apiRequest(`/appointments/${appointmentId}/consultation/join`, { method: 'POST' })),
  saveNote: (appointmentId, body) =>
    data(apiRequest(`/appointments/${appointmentId}/consultation/note`, { method: 'PUT', body })),
  signNote: (appointmentId) =>
    data(apiRequest(`/appointments/${appointmentId}/consultation/note/sign`, { method: 'POST' })),
  correctNote: (noteId, body) =>
    data(apiRequest(`/clinical-notes/${noteId}/corrections`, { method: 'POST', body })),
  saveDraft: (appointmentId, body) =>
    data(
      apiRequest(`/appointments/${appointmentId}/consultation/prescription`, {
        method: 'PUT',
        body,
      }),
    ),
  signPrescription: (id) => data(apiRequest(`/prescriptions/${id}/sign`, { method: 'POST' })),
  correctPrescription: (id, body) =>
    data(apiRequest(`/prescriptions/${id}/corrections`, { method: 'POST', body })),
  pdfUrl: (id) => data(apiRequest(`/prescriptions/${id}/pdf-url`, { method: 'POST' })),
  forPatient: (patientId) => data(apiRequest(`/patients/${patientId}/prescriptions`)),
  outcome: (appointmentId, body) =>
    data(
      apiRequest(`/appointments/${appointmentId}/consultation/outcome`, { method: 'POST', body }),
    ),
};

/** Follow-ups (M10): check-ins from the treating doctor; escalation is rule-based. */
export const followUpApi = {
  forDoctor: (status) => data(apiRequest(`/doctors/me/follow-ups${qs({ status })}`)),
  forPatient: (patientId) => data(apiRequest(`/patients/${patientId}/follow-ups`)),
  get: (id) => data(apiRequest(`/follow-ups/${id}`)),
  schedule: (patientId, body) =>
    data(apiRequest(`/patients/${patientId}/follow-ups`, { method: 'POST', body })),
  respond: (id, body) => data(apiRequest(`/follow-ups/${id}/responses`, { method: 'POST', body })),
  close: (id, note) =>
    data(apiRequest(`/follow-ups/${id}/close`, { method: 'POST', body: { note } })),
};

/** In-app notifications (M10): own inbox only. */
export const inboxApi = {
  list: (params = {}) => apiRequest(`/notifications${qs(params)}`),
  unreadCount: () => data(apiRequest('/notifications/unread-count')),
  read: (id) => data(apiRequest(`/notifications/${id}/read`, { method: 'POST' })),
  readAll: () => data(apiRequest('/notifications/read-all', { method: 'POST' })),
};
