-- AiExtractionSuggestion decision columns — 2026-06-05
--
-- Closes the v2.1 control-deficiency-log #26 item documented in
-- ledger-core PR #48: revenue-rec's hybrid DSR attribution helper
-- returns zero for `aiExtractionsAccepted` / `aiExtractionsRejected`
-- because the schema lacks a decision column. This migration adds
-- the columns + indices.
--
-- After this migration applies + the helper update lands, the
-- attribution helper flips from hybrid (2/5 wired) to FULL-WIRE
-- (5/5 wired).
--
-- Idempotent: every ALTER uses IF NOT EXISTS / DO blocks; safe to
-- re-run after a partial failure.

ALTER TABLE ai_extraction_suggestion
  ADD COLUMN IF NOT EXISTS "acceptedBy" UUID,
  ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectedBy" UUID,
  ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS ai_extraction_suggestion_acceptedBy_idx
  ON ai_extraction_suggestion ("acceptedBy");

CREATE INDEX IF NOT EXISTS ai_extraction_suggestion_rejectedBy_idx
  ON ai_extraction_suggestion ("rejectedBy");
