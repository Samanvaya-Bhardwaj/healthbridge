import { createTokenService } from './core/auth/tokens.js';
import { createPasswordHasher, DEFAULT_ARGON2_PARAMS } from './core/auth/passwordHasher.js';
import { createAuthenticate } from './core/auth/authenticate.js';
import { createAccessPolicy } from './core/authz/accessPolicy.js';
import { createAuditService } from './modules/audit/service.js';
import { createAuditRepository } from './modules/audit/repository.js';
import { createUserRepository } from './modules/identity/repositories/userRepository.js';
import { createRoleRepository } from './modules/identity/repositories/roleRepository.js';
import { createSessionRepository } from './modules/identity/repositories/sessionRepository.js';
import { createAuthService } from './modules/identity/authService.js';
import { createAccountRecoveryService } from './modules/identity/accountRecoveryService.js';
import { createAccountService } from './modules/identity/accountService.js';
import { createAdminUserService } from './modules/admin/service.js';
import { createCareAccess } from './modules/care-access/relationships.js';
import { createPatientRepository } from './modules/patients/repository.js';
import { createPatientService } from './modules/patients/service.js';
import { createDoctorRepository } from './modules/doctors/repository.js';
import { createDoctorService } from './modules/doctors/service.js';
import { createClinicRepository } from './modules/clinics/repository.js';
import { createClinicService } from './modules/clinics/service.js';
import { createCareRepository } from './modules/care/repository.js';
import { createCareService } from './modules/care/service.js';
import {
  createAppointmentRepository,
  createAvailabilityRepository,
} from './modules/scheduling/repository.js';
import { createAvailabilityService } from './modules/scheduling/availabilityService.js';
import { createAppointmentService } from './modules/scheduling/appointmentService.js';
import { createPaymentRepository } from './modules/payments/repository.js';
import { createPaymentProvider } from './modules/payments/providers/index.js';
import { createPaymentSettlement } from './modules/payments/settlement.js';
import { createWebhookService } from './modules/payments/webhookService.js';
import { createPaymentService } from './modules/payments/paymentService.js';
import { createFakeRefundSettler } from './modules/payments/fakeRefundSettler.js';
import { createNotificationProvider } from './modules/notifications/notificationProvider.js';
import { createNotificationService } from './modules/notifications/notificationService.js';
import { createOperationsService } from './modules/operations/service.js';
import { createDocumentStorage } from './core/storage/documentStorage.js';
import { createDocumentScanner } from './modules/documents/scanning/documentScanner.js';
import { createDocumentRepository } from './modules/documents/repository.js';
import { createDocumentService } from './modules/documents/service.js';
import { createDocumentPipeline } from './modules/documents/pipeline.js';
import { createConsentRepository, createConsentService } from './modules/consents/service.js';
import { createAccessLogService } from './modules/consents/accessLog.js';
import { createIntelligenceService } from './modules/intelligence/service.js';
import { createTimelineProjector } from './modules/timeline/projector.js';
import { createTimelineService } from './modules/timeline/service.js';
import { createAssistService } from './modules/assist/service.js';
import { createAssistantService } from './modules/assistant/service.js';
import { createAssistantRepository } from './modules/assistant/repository.js';
import { createEnvelope } from './core/crypto/envelope.js';
import { createVideoProvider } from './modules/consultations/videoProvider.js';
import { createConsultationService } from './modules/consultations/service.js';
import { createPrescriptionService } from './modules/consultations/prescriptions.js';
import { createFollowUpService } from './modules/followups/service.js';
import { createInboxService } from './modules/notifications/inbox.js';

/** Rate limits for authentication endpoints (points per window). */
export const DEFAULT_RATE_LIMITS = Object.freeze({
  global: { points: 300, durationSeconds: 60 }, // per IP, all /api routes
  register: { points: 10, durationSeconds: 3600 }, // per IP
  loginIp: { points: 30, durationSeconds: 900 }, // per IP
  loginAccount: { points: 10, durationSeconds: 900 }, // per account (hashed email)
  refresh: { points: 60, durationSeconds: 60 }, // per IP
  passwordChange: { points: 5, durationSeconds: 900 }, // per user
  passwordResetIp: { points: 10, durationSeconds: 3600 }, // per IP
  passwordResetAccount: { points: 3, durationSeconds: 3600 }, // per account (hashed email)
  accountTokenIp: { points: 30, durationSeconds: 900 }, // per IP: reset / verify submissions
  emailVerification: { points: 5, durationSeconds: 3600 }, // per user
  careInvite: { points: 20, durationSeconds: 3600 }, // per doctor
});

/**
 * Composition root: wires repositories, services and policies. The only place that
 * decides concrete implementations, so tests can substitute any dependency.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config/index.js').loadConfig>,
 *   logger: import('pino').Logger,
 *   knex: import('knex').Knex,
 *   redis?: import('ioredis').Redis,
 *   mailer: import('./core/mail/mailer.js').Mailer,
 *   passwordHashParams?: typeof DEFAULT_ARGON2_PARAMS,
 *   rateLimits?: Partial<typeof DEFAULT_RATE_LIMITS>,
 *   now?: () => Date,
 *   paymentProvider?: import('./modules/payments/providers/paymentProvider.js').PaymentProvider,
 *   notificationProvider?: import('./modules/notifications/notificationProvider.js').NotificationProvider,
 *   queues?: Record<string, import('bullmq').Queue>,
 *   documentStorage?: ReturnType<typeof import('./core/storage/documentStorage.js').createDocumentStorage>,
 *   documentScanner?: import('./modules/documents/scanning/documentScanner.js').DocumentScanner,
 *   aiClient?: ReturnType<typeof import('./core/ai/client.js').createAiClient>,
 *   videoProvider?: import('./modules/consultations/videoProvider.js').VideoProvider,
 *   options?: { fakeAutoSettleRefunds?: boolean },
 * }} deps
 */
export function createContainer({
  config,
  logger,
  knex,
  redis,
  mailer,
  passwordHashParams = DEFAULT_ARGON2_PARAMS,
  rateLimits = {},
  now,
  paymentProvider = createPaymentProvider(config.payments),
  notificationProvider = createNotificationProvider(config, { logger }),
  queues,
  documentStorage = createDocumentStorage(config.storage),
  documentScanner = createDocumentScanner(config.documents),
  aiClient,
  videoProvider = createVideoProvider(config.video),
  options = {},
}) {
  const audit = createAuditService({ knex, logger });
  const auditRepository = createAuditRepository({ knex });
  const users = createUserRepository({ knex });
  const roles = createRoleRepository({ knex });
  const sessions = createSessionRepository({ knex });
  const hasher = createPasswordHasher(passwordHashParams);
  const tokens = createTokenService({
    signingKeys: config.auth.signingKeys,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
  });

  const careAccess = createCareAccess({ knex });
  const accessPolicy = createAccessPolicy({
    audit,
    logger,
    relationshipResolvers: {
      // A session belongs to exactly one user.
      session: (principal, resource) => ({
        related: Boolean(resource.ownerUserId) && resource.ownerUserId === principal.userId,
        relationship: 'owner',
      }),
      ...careAccess.resolvers,
    },
    consentResolver: careAccess.consentResolver,
  });

  const patients = createPatientRepository();
  const doctors = createDoctorRepository({ knex });
  const clinics = createClinicRepository({ knex });
  const care = createCareRepository();
  const availability = createAvailabilityRepository({ knex });
  const appointments = createAppointmentRepository();
  const payments = createPaymentRepository();
  const consents = createConsentRepository();
  const medicalDocuments = createDocumentRepository();

  const accountRecovery = createAccountRecoveryService({
    knex,
    users,
    sessions,
    hasher,
    audit,
    mailer,
    logger,
    appUrl: config.http.publicAppUrl,
    ...(now ? { now } : {}),
  });
  const authService = createAuthService({
    knex,
    users,
    roles,
    sessions,
    hasher,
    tokens,
    audit,
    mailer,
    logger,
    // New accounts receive an email-verification link (sent after the response).
    onRegistered: (userId, req) => accountRecovery.sendEmailVerification(userId, req),
    sessionLifetimes: config.auth.session,
    ...(now ? { now } : {}),
  });
  const accountService = createAccountService({
    knex,
    users,
    sessions,
    hasher,
    audit,
    accessPolicy,
  });
  const adminUserService = createAdminUserService({ knex, users, roles, sessions, audit, hasher });
  const patientService = createPatientService({ knex, patients, accessPolicy, audit, logger });
  const doctorService = createDoctorService({ knex, doctors, roles, accessPolicy, audit });
  const clinicService = createClinicService({
    knex,
    clinics,
    users,
    roles,
    doctors,
    accessPolicy,
    audit,
  });
  const careService = createCareService({
    knex,
    care,
    patients,
    doctors,
    clinics,
    accessPolicy,
    audit,
  });
  const availabilityService = createAvailabilityService({
    knex,
    availability,
    appointments,
    doctors,
    clinics,
    accessPolicy,
    audit,
  });
  const appointmentService = createAppointmentService({
    knex,
    appointments,
    availability,
    care,
    patients,
    doctors,
    accessPolicy,
    audit,
    logger,
  });
  const settlement = createPaymentSettlement({
    knex,
    payments,
    appointments,
    audit,
    provider: paymentProvider,
    logger,
    ...(now ? { now } : {}),
  });
  const webhookService = createWebhookService({
    provider: paymentProvider,
    settlement,
    audit,
    logger,
  });
  const paymentService = createPaymentService({
    knex,
    config,
    payments,
    appointments,
    accessPolicy,
    audit,
    provider: paymentProvider,
    settlement,
    webhookService,
    ...(now ? { now } : {}),
  });
  const notificationService = createNotificationService({
    knex,
    appointments,
    provider: notificationProvider,
    logger,
    config,
    ...(now ? { now } : {}),
  });
  const operationsService = createOperationsService({ knex, audit, queues });
  const consentService = createConsentService({
    knex,
    consents,
    doctors,
    appointments,
    careAccess,
    accessPolicy,
    audit,
    ...(now ? { now } : {}),
  });
  const accessLogService = createAccessLogService({ knex, accessPolicy });
  const timelineProjector = createTimelineProjector({ knex, logger });
  const timelineService = createTimelineService({ knex, accessPolicy, audit });
  const assistService = createAssistService({ knex, aiClient, accessPolicy, audit });
  // M13.1: the care assistant orchestrates existing read services; the AI only plans.
  const assistantService = createAssistantService({
    knex,
    aiClient,
    accessPolicy,
    audit,
    repository: createAssistantRepository(),
    careService,
    doctorService,
    availabilityService,
    logger,
    ...(now ? { now } : {}),
  });
  const envelope = createEnvelope(config.clinicalData);
  const consultationService = createConsultationService({
    knex,
    accessPolicy,
    audit,
    envelope,
    video: videoProvider,
    ...(now ? { now } : {}),
  });
  const followUpService = createFollowUpService({
    knex,
    accessPolicy,
    audit,
    envelope,
    aiClient,
    logger,
    ...(now ? { now } : {}),
  });
  const inboxService = createInboxService({ knex, accessPolicy, ...(now ? { now } : {}) });
  const prescriptionService = createPrescriptionService({
    knex,
    config,
    accessPolicy,
    audit,
    storage: documentStorage,
    logger,
    ...(now ? { now } : {}),
  });
  const intelligenceService = createIntelligenceService({
    knex,
    config,
    aiClient,
    storage: documentStorage,
    documents: medicalDocuments,
    accessPolicy,
    audit,
    logger,
  });
  const documentService = createDocumentService({
    knex,
    config,
    documents: medicalDocuments,
    storage: documentStorage,
    accessPolicy,
    audit,
    logger,
    ...(now ? { now } : {}),
  });
  const documentPipeline = createDocumentPipeline({
    knex,
    config,
    documents: medicalDocuments,
    storage: documentStorage,
    scanner: documentScanner,
    audit,
    logger,
    ...(now ? { now } : {}),
  });
  const fakeRefundSettler =
    paymentProvider.name === 'fake'
      ? createFakeRefundSettler({ knex, payments, provider: paymentProvider, webhookService })
      : null;
  const authenticate = createAuthenticate({
    tokenService: tokens,
    resolvePrincipal: authService.resolvePrincipal,
  });

  return {
    config,
    logger,
    knex,
    redis,
    queues,
    options,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...rateLimits },
    audit,
    auditRepository,
    repositories: {
      users,
      roles,
      sessions,
      patients,
      doctors,
      clinics,
      care,
      availability,
      appointments,
      payments,
      consents,
      medicalDocuments,
    },
    careAccess,
    hasher,
    tokens,
    accessPolicy,
    authService,
    accountRecovery,
    accountService,
    adminUserService,
    patientService,
    doctorService,
    clinicService,
    careService,
    availabilityService,
    appointmentService,
    paymentProvider,
    notificationProvider,
    settlement,
    webhookService,
    paymentService,
    notificationService,
    operationsService,
    fakeRefundSettler,
    documentStorage,
    documentScanner,
    consentService,
    accessLogService,
    documentService,
    documentPipeline,
    intelligenceService,
    timelineProjector,
    timelineService,
    assistService,
    assistantService,
    consultationService,
    prescriptionService,
    followUpService,
    inboxService,
    videoProvider,
    aiClient,
    authenticate,
  };
}
