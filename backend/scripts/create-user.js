#!/usr/bin/env node
// Provision a staff account, e.g. the first platform administrator. Public registration
// only ever creates PATIENT accounts, so privileged accounts start here.
//
//   BOOTSTRAP_PASSWORD='…' node scripts/create-user.js \
//     --email admin@example.org --name "Platform Admin" --role PLATFORM_ADMIN
//
// The password is read from BOOTSTRAP_PASSWORD (never a CLI argument, which would land in
// shell history and process listings). If unset, a strong random password is generated
// and shown once on stderr.

import { randomBytes } from 'node:crypto';
import { ALL_ROLES, emailSchema, fullNameSchema } from '@healthbridge/shared';
import { createScriptRuntime, parseArgs } from './lib/runtime.js';

const args = parseArgs();
const roles = String(args.role ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const email = emailSchema.safeParse(args.email);
const fullName = fullNameSchema.safeParse(args.name);
if (
  !email.success ||
  !fullName.success ||
  !roles.length ||
  roles.some((r) => !ALL_ROLES.includes(r))
) {
  console.error(
    `Usage: create-user --email <email> --name <full name> --role <${ALL_ROLES.join('|')}>[,…]`,
  );
  process.exit(2);
}

const generated = !process.env.BOOTSTRAP_PASSWORD;
const password = process.env.BOOTSTRAP_PASSWORD ?? randomBytes(18).toString('base64url');

const runtime = createScriptRuntime('create-user');
try {
  const result = await runtime.container.adminUserService.provisionUser({
    email: email.data,
    fullName: fullName.data,
    password,
    roles,
  });
  console.log(
    JSON.stringify({
      msg: result.created ? 'user created' : 'user exists; roles ensured',
      ...result,
    }),
  );
  if (result.created && generated) {
    console.error(`Generated password (shown once, change it after first sign-in): ${password}`);
  }
} catch (err) {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: 'create-user failed',
      error: err.message,
      details: err.extensions,
    }),
  );
  process.exitCode = 1;
} finally {
  await runtime.close();
}
