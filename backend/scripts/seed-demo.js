#!/usr/bin/env node
// Seeds SYNTHETIC demo accounts, one per role. Never real people or real health data.
// Runs only with DEMO_MODE=true outside production. Idempotent.
//
//   npm run seed:demo -w backend
//
// All accounts use DEMO_USER_PASSWORD from .env and the reserved, non-routable
// demo.healthbridge.local domain. They are flagged is_demo=true.

import { ROLES } from '@healthbridge/shared';
import { createScriptRuntime } from './lib/runtime.js';

const DEMO_DOMAIN = 'demo.healthbridge.local';

/** Clearly fictional people; names are labelled as demo accounts. */
const DEMO_USERS = [
  { local: 'patient.asha', fullName: 'Asha Rao (Demo Patient)', roles: [ROLES.PATIENT] },
  { local: 'patient.vikram', fullName: 'Vikram Singh (Demo Patient)', roles: [ROLES.PATIENT] },
  { local: 'dr.meera', fullName: 'Dr. Meera Iyer (Demo Doctor)', roles: [ROLES.DOCTOR] },
  {
    local: 'clinic.admin',
    fullName: 'Kiran Patel (Demo Clinic Admin)',
    roles: [ROLES.CLINIC_ADMIN],
  },
  {
    local: 'platform.admin',
    fullName: 'Neha Joshi (Demo Platform Admin)',
    roles: [ROLES.PLATFORM_ADMIN],
  },
  { local: 'support', fullName: 'Arjun Das (Demo Support)', roles: [ROLES.SUPPORT] },
];

const runtime = createScriptRuntime('seed-demo');
const { config } = runtime;

try {
  if (!config.demoMode || config.isProduction) {
    throw new Error('Demo seeding requires DEMO_MODE=true and a non-production APP_ENV.');
  }
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password)
    throw new Error('DEMO_USER_PASSWORD is not set (run node scripts/generate-env.mjs --update).');

  for (const user of DEMO_USERS) {
    const email = `${user.local}@${DEMO_DOMAIN}`;
    const result = await runtime.container.adminUserService.provisionUser({
      email,
      fullName: user.fullName,
      password,
      roles: user.roles,
      isDemo: true,
    });
    console.log(
      JSON.stringify({
        msg: result.created ? 'demo user created' : 'demo user exists',
        email,
        roles: result.roles,
      }),
    );
  }
  console.log(
    JSON.stringify({ msg: 'demo seed complete', password: 'DEMO_USER_PASSWORD from .env' }),
  );
} catch (err) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'demo seed failed', error: err.message }));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
