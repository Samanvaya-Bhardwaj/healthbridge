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
import { createAccountService } from './modules/identity/accountService.js';
import { createAdminUserService } from './modules/admin/service.js';

/** Rate limits for authentication endpoints (points per window). */
export const DEFAULT_RATE_LIMITS = Object.freeze({
  global: { points: 300, durationSeconds: 60 }, // per IP, all /api routes
  register: { points: 10, durationSeconds: 3600 }, // per IP
  loginIp: { points: 30, durationSeconds: 900 }, // per IP
  loginAccount: { points: 10, durationSeconds: 900 }, // per account (hashed email)
  refresh: { points: 60, durationSeconds: 60 }, // per IP
  passwordChange: { points: 5, durationSeconds: 900 }, // per user
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

  const accessPolicy = createAccessPolicy({
    audit,
    logger,
    relationshipResolvers: {
      // A session belongs to exactly one user.
      session: (principal, resource) => ({
        related: Boolean(resource.ownerUserId) && resource.ownerUserId === principal.userId,
        relationship: 'owner',
      }),
    },
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
  const authenticate = createAuthenticate({
    tokenService: tokens,
    resolvePrincipal: authService.resolvePrincipal,
  });

  return {
    config,
    logger,
    redis,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...rateLimits },
    audit,
    auditRepository,
    repositories: { users, roles, sessions },
    hasher,
    tokens,
    accessPolicy,
    authService,
    accountService,
    adminUserService,
    authenticate,
  };
}
