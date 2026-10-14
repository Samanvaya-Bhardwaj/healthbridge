import { createHash } from 'node:crypto';
import { practiceAreaLabel } from '@healthbridge/shared';

const BATCH = 32;
const QUERY_CACHE_LIMIT = 500;

/** The public text a doctor is found by (no patient data; languages are a filter). */
export function profileText(row) {
  const areas = (row.areas_of_practice ?? []).map(practiceAreaLabel).filter(Boolean);
  return [
    row.professional_name,
    row.primary_specialization,
    ...(row.additional_specializations ?? []),
    ...(row.specialties ?? []),
    areas.length ? `Areas of practice: ${areas.join(', ')}` : null,
    row.bio,
  ]
    .filter(Boolean)
    .join('. ')
    .slice(0, 2000);
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const toVector = (values) => `[${values.join(',')}]`;

/**
 * Vector side of doctor search (M13.2, ADR-0031). Embeddings come from the AI service's
 * configured provider and only re-rank results that the filters already chose.
 *
 * - `refresh()` re-embeds bookable doctors whose public profile text changed (or that have
 *   none yet), in batches; run by a maintenance job. Idempotent.
 * - `embedQuery(text)` embeds a query built from the controlled vocabulary (specialty and
 *   area names). Those are few, so results are cached in memory. Any failure returns
 *   null: search then ranks without vectors instead of failing.
 */
export function createDoctorSearchIndex({ knex, aiClient, logger }) {
  const queryCache = new Map();

  async function refresh({ limit = 200 } = {}) {
    if (!aiClient?.embedPublic) return { embedded: 0, skipped: 'no_ai_client' };
    const rows = await knex('doctors as d')
      .leftJoin('doctor_profile_embeddings as e', 'e.doctor_id', 'd.id')
      .whereRaw('authz.doctor_is_bookable(d.id)')
      .select(
        'd.id',
        'd.professional_name',
        'd.primary_specialization',
        'd.additional_specializations',
        'd.specialties',
        'd.areas_of_practice',
        'd.bio',
        'e.content_hash',
      )
      .orderBy('d.id')
      .limit(5000);
    const stale = rows
      .map((row) => ({ id: row.id, text: profileText(row), stored: row.content_hash }))
      .map((r) => ({ ...r, hash: sha256(r.text) }))
      .filter((r) => r.hash !== r.stored)
      .slice(0, limit);
    let embedded = 0;
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      const { model, vectors } = await aiClient.embedPublic({
        purpose: 'doctor_profile',
        kind: 'document',
        texts: batch.map((r) => r.text),
      });
      await knex.transaction(async (trx) => {
        for (const [k, r] of batch.entries()) {
          await trx('doctor_profile_embeddings')
            .insert({
              doctor_id: r.id,
              content_hash: r.hash,
              model,
              embedding: toVector(vectors[k]),
              updated_at: trx.fn.now(),
            })
            .onConflict('doctor_id')
            .merge(['content_hash', 'model', 'embedding', 'updated_at']);
        }
      });
      embedded += batch.length;
    }
    return { embedded, pending: Math.max(0, stale.length - embedded) };
  }

  /** @returns {Promise<string|null>} a pgvector literal, or null when unavailable */
  async function embedQuery(text) {
    if (!text || !aiClient?.embedPublic) return null;
    if (queryCache.has(text)) return queryCache.get(text);
    try {
      const { vectors } = await aiClient.embedPublic(
        { purpose: 'doctor_search_query', kind: 'query', texts: [text] },
        { timeout: 1_500 },
      );
      const vector = toVector(vectors[0]);
      if (queryCache.size >= QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value);
      queryCache.set(text, vector);
      return vector;
    } catch (err) {
      logger?.warn({ errName: err?.name }, 'doctor search query embedding unavailable');
      return null;
    }
  }

  return { refresh, embedQuery };
}
