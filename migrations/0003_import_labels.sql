-- =============================================================================
-- Practice App — schema version 3: a name and a note for each import.
-- Additive only.
-- =============================================================================

ALTER TABLE import_batch ADD COLUMN label TEXT;
ALTER TABLE import_batch ADD COLUMN note TEXT;

INSERT INTO schema_migration (version, name, applied_at, backup_ref)
VALUES (3, '0003_import_labels',
        CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER), NULL);
