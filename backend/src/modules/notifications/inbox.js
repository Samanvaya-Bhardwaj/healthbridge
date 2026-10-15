import { INBOX_PAGE_LIMIT, NOTIFICATION_CATEGORIES, PERMISSIONS } from '@healthbridge/shared';
import { isUuid } from '../../core/db/ids.js';
import { withActor } from '../../core/db/actorContext.js';
import { BadRequestError, NotFoundError } from '../../core/http/errors.js';

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ t: row.created_at.toISOString(), id: row.id })).toString(
    'base64url',
  );
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isUuid(id) || Number.isNaN(Date.parse(t))) throw new Error('bad cursor');
    return { t, id };
  } catch {
    throw new BadRequestError('Invalid cursor.', 'invalid_cursor');
  }
}

const toView = (row) => ({
  id: row.id,
  template: row.template,
  title: row.title,
  body: row.body,
  link: row.link,
  priority: row.priority,
  createdAt: row.created_at,
  readAt: row.read_at,
});

/** In-app inbox (ADR-0026): own notifications only (RLS), read/unread state. */
/** Database row ↔ API shape (no row: every category on). */
export const toPreferencesView = (row) => ({
  email: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, row?.[`email_${c}`] ?? true])),
  sms: row?.sms ?? true,
});

export function createInboxService({ knex, accessPolicy, audit, now = () => new Date() }) {
  const gate = (trx, principal, req) =>
    accessPolicy.enforce({ principal, permission: PERMISSIONS.NOTIFICATIONS_READ, req, trx });

  async function list(principal, { cursor, unreadOnly = false, limit = 20 } = {}, req) {
    const after = decodeCursor(cursor);
    const size = Math.min(Math.max(limit, 1), INBOX_PAGE_LIMIT);
    return withActor(knex, principal.userId, async (trx) => {
      await gate(trx, principal, req);
      const q = trx('inbox_notifications')
        .where({ user_id: principal.userId })
        .orderBy([
          { column: 'created_at', order: 'desc' },
          { column: 'id', order: 'desc' },
        ])
        .limit(size + 1);
      if (unreadOnly) q.whereNull('read_at');
      if (after) q.whereRaw('(created_at, id) < (?::timestamptz, ?::uuid)', [after.t, after.id]);
      const rows = await q;
      const unread = await trx('inbox_notifications')
        .where({ user_id: principal.userId })
        .whereNull('read_at')
        .count({ n: '*' })
        .first();
      const page = rows.slice(0, size);
      return {
        data: page.map(toView),
        meta: {
          unreadCount: Number(unread.n),
          nextCursor: rows.length > size ? encodeCursor(page[page.length - 1]) : null,
        },
      };
    });
  }

  async function unreadCount(principal, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await gate(trx, principal, req);
      const row = await trx('inbox_notifications')
        .where({ user_id: principal.userId })
        .whereNull('read_at')
        .count({ n: '*' })
        .first();
      return { unreadCount: Number(row.n) };
    });
  }

  async function markRead(principal, id, req) {
    if (!isUuid(id)) throw new NotFoundError();
    return withActor(knex, principal.userId, async (trx) => {
      await gate(trx, principal, req);
      const row = await trx('inbox_notifications').where({ id }).first();
      if (!row) throw new NotFoundError();
      if (!row.read_at) {
        await trx('inbox_notifications').where({ id }).update({ read_at: now() });
      }
      return toView(await trx('inbox_notifications').where({ id }).first());
    });
  }

  async function markAllRead(principal, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await gate(trx, principal, req);
      const updated = await trx('inbox_notifications')
        .where({ user_id: principal.userId })
        .whereNull('read_at')
        .update({ read_at: now() });
      return { updated };
    });
  }

  // ── Step 8: notification preferences (own account only; RLS confines the row) ──

  async function getPreferences(principal, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({ principal, permission: PERMISSIONS.ACCOUNT_READ, req, trx });
      const row = await trx('notification_preferences')
        .where({ user_id: principal.userId })
        .first();
      return toPreferencesView(row);
    });
  }

  /** @param {{ email?: Record<string, boolean>, sms?: boolean }} patch */
  async function updatePreferences(principal, patch, req) {
    return withActor(knex, principal.userId, async (trx) => {
      await accessPolicy.enforce({ principal, permission: PERMISSIONS.ACCOUNT_UPDATE, req, trx });
      const current = toPreferencesView(
        await trx('notification_preferences').where({ user_id: principal.userId }).first(),
      );
      const next = {
        email: { ...current.email, ...(patch.email ?? {}) },
        sms: patch.sms ?? current.sms,
      };
      const row = {
        user_id: principal.userId,
        ...Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [`email_${c}`, next.email[c]])),
        sms: next.sms,
        updated_at: now(),
      };
      await trx('notification_preferences').insert(row).onConflict('user_id').merge();
      await audit?.record(
        {
          category: 'account',
          action: 'account.notification_preferences_update',
          outcome: 'success',
          resourceType: 'user',
          resourceId: principal.userId,
          // What is off (category names only), never message content.
          metadata: {
            emailOff: NOTIFICATION_CATEGORIES.filter((c) => !next.email[c]),
            sms: next.sms,
          },
        },
        { req, trx },
      );
      return next;
    });
  }

  return { list, unreadCount, markRead, markAllRead, getPreferences, updatePreferences };
}
