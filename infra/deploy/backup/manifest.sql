-- Backup manifest: schema version and row counts only (never row contents). Taken in the
-- same snapshot as the dump, so a restore must reproduce it exactly (restore drill).
\pset footer off
SELECT 'migrations', count(*)::text FROM knex_migrations
UNION ALL SELECT 'latest_migration', max(name) FROM knex_migrations
UNION ALL SELECT 'users', count(*)::text FROM users
UNION ALL SELECT 'patients', count(*)::text FROM patients
UNION ALL SELECT 'doctors', count(*)::text FROM doctors
UNION ALL SELECT 'care_relationships', count(*)::text FROM care_relationships
UNION ALL SELECT 'appointments', count(*)::text FROM appointments
UNION ALL SELECT 'payments', count(*)::text FROM payments
UNION ALL SELECT 'consents', count(*)::text FROM consents
UNION ALL SELECT 'medical_documents', count(*)::text FROM medical_documents
UNION ALL SELECT 'consultations', count(*)::text FROM consultations
UNION ALL SELECT 'prescriptions', count(*)::text FROM prescriptions
UNION ALL SELECT 'follow_ups', count(*)::text FROM follow_ups
UNION ALL SELECT 'outbox_events', count(*)::text FROM outbox_events
UNION ALL SELECT 'audit_logs', count(*)::text FROM audit.audit_logs
UNION ALL SELECT 'ai_runs', count(*)::text FROM ai.ai_runs
UNION ALL SELECT 'rls_tables', count(*)::text FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND c.relrowsecurity AND n.nspname IN ('public', 'ai')
UNION ALL SELECT 'triggers', count(*)::text FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname IN ('public', 'ai', 'audit');
