import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@healthbridge/shared';

/**
 * Compares the database RBAC catalog with the code contract in @healthbridge/shared.
 * @returns {{ missingPermissions: string[], unexpectedPermissions: string[], mappingDiff: string[] }}
 */
export function diffPermissionCatalog({ permissions, mapping }) {
  const dbPermissions = new Set(permissions);
  const missingPermissions = ALL_PERMISSIONS.filter((p) => !dbPermissions.has(p));
  const unexpectedPermissions = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));

  const dbPairs = new Set(mapping.map((m) => `${m.role}:${m.permission}`));
  const codePairs = new Set(
    Object.entries(ROLE_PERMISSIONS).flatMap(([role, perms]) => perms.map((p) => `${role}:${p}`)),
  );
  const mappingDiff = [
    ...[...codePairs].filter((pair) => !dbPairs.has(pair)).map((pair) => `missing ${pair}`),
    ...[...dbPairs].filter((pair) => !codePairs.has(pair)).map((pair) => `unexpected ${pair}`),
  ];
  return { missingPermissions, unexpectedPermissions, mappingDiff };
}

/** Throws at startup when the catalog drifted (e.g. a migration was not applied). */
export async function assertPermissionCatalog(roleRepository) {
  const diff = diffPermissionCatalog(await roleRepository.permissionCatalog());
  const problems = [
    ...diff.missingPermissions.map((p) => `missing permission ${p}`),
    ...diff.unexpectedPermissions.map((p) => `unexpected permission ${p}`),
    ...diff.mappingDiff,
  ];
  if (problems.length) {
    throw new Error(`RBAC catalog mismatch between database and code: ${problems.join('; ')}`);
  }
}
