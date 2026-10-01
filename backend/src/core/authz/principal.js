/**
 * @typedef {object} Principal
 * @property {string} userId
 * @property {string} sessionId
 * @property {string} email
 * @property {string} fullName
 * @property {string[]} roles
 * @property {Set<string>} permissions
 */

/** Serializable view of a principal for API responses (never includes secrets). */
export function principalView(principal) {
  return {
    id: principal.userId,
    email: principal.email,
    fullName: principal.fullName,
    roles: [...principal.roles].sort(),
    permissions: [...principal.permissions].sort(),
  };
}
