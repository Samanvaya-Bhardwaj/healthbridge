import { assertActorTransaction } from '../../core/db/actorContext.js';

/**
 * `agent_sessions` (M13.1): structured care-assistant state, owned by the acting user.
 * All reads and writes run in that user's actor transaction, so RLS confines them to the
 * user's own sessions. Deleting is only possible for the retention sweep.
 */
export function createAssistantRepository() {
  return {
    insert(trx, row) {
      assertActorTransaction(trx);
      return trx('agent_sessions').insert(row);
    },
    find(trx, id) {
      assertActorTransaction(trx);
      return trx('agent_sessions').where({ id }).first();
    },
    /** Writes the next state only if nobody else advanced the session meanwhile. */
    async advance(trx, id, version, patch) {
      assertActorTransaction(trx);
      const updated = await trx('agent_sessions')
        .where({ id, version, status: 'active' })
        .where('expires_at', '>', trx.fn.now())
        .update({ ...patch, version: version + 1, turn_count: trx.raw('turn_count + 1') })
        .returning(['version', 'turn_count']);
      return updated[0] ?? null;
    },
    end(trx, id) {
      assertActorTransaction(trx);
      return trx('agent_sessions').where({ id, status: 'active' }).update({ status: 'ended' });
    },
    /** Retention sweep (system purpose `assistant`): expired sessions are deleted. */
    deleteExpired(trx) {
      return trx('agent_sessions').where('expires_at', '<=', trx.fn.now()).delete();
    },
  };
}
