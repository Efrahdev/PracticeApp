-- =============================================================================
-- Practice App — schema version 2: canonical question packs.
-- Additive only: every existing row stays valid and keeps its meaning.
--
--   question.external_ref      permanent reference from the pack ("<pack id>/<question id>");
--                              the same reference with changed content becomes a new version.
--   question.marks             marks / points for the whole question.
--   question_version.content_format
--                              'html_fragment' = v1 imports (html_blob_sha256 is an HTML fragment)
--                              'qpack_v1'      = html_blob_sha256 is the canonical question JSON
--                                                (practice-app/question@1), rendered by the app.
--   solution.body_format       how body_text is written: plain text, Markdown (+ LaTeX) or HTML.
--   paper.solutions_mode       'included' = solutions can be opened while practising and are
--                              printed with the paper; 'hidden' = left out of the paper.
-- =============================================================================

ALTER TABLE question ADD COLUMN external_ref TEXT;
ALTER TABLE question ADD COLUMN marks REAL CHECK (marks IS NULL OR marks >= 0);
CREATE UNIQUE INDEX question_external_ref_unique ON question(external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE question_version ADD COLUMN content_format TEXT NOT NULL DEFAULT 'html_fragment'
  CHECK (content_format IN ('html_fragment', 'qpack_v1'));

ALTER TABLE solution ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text'
  CHECK (body_format IN ('text', 'markdown', 'html'));

ALTER TABLE paper ADD COLUMN solutions_mode TEXT NOT NULL DEFAULT 'included'
  CHECK (solutions_mode IN ('included', 'hidden'));

-- The current-version view now also exposes the content format.
DROP VIEW v_question_current;
CREATE VIEW v_question_current AS
SELECT q.*, v.id AS version_id, v.version_no, v.content_sha256,
       v.html_blob_sha256, v.content_format, v.plain_text, v.import_batch_id,
       v.source_position, v.source_question_number
FROM question q
JOIN question_version v
  ON v.question_id = q.id
 AND v.version_no = (SELECT max(version_no) FROM question_version WHERE question_id = q.id);

INSERT INTO schema_migration (version, name, applied_at, backup_ref)
VALUES (2, '0002_question_pack',
        CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER), NULL);
