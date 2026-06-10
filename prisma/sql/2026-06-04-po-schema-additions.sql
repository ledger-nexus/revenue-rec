-- PerformanceObligation schema additions — 2026-06-04
--
-- Closes the gap surfaced by ledger-core PR #39 (NetSuite revenue-
-- rec validation pass). Adds four columns + two enums:
--
--   - allocatedAmount Decimal(18,4) NULL — null means "use SSP" (back-compat)
--   - allocationMethod AllocationMethod NULL — PROPORTIONAL/RESIDUAL/MANUAL
--   - fairValueMethod FairValueMethod NULL — ESP/VSOE/TPE/RESIDUAL
--   - quantity Decimal(18,4) NOT NULL DEFAULT 1 — defaults to 1 for back-compat
--
-- All additions are NULL-tolerant (or DEFAULT 1 for quantity), so
-- pre-migration rows + pre-migration callers continue to work
-- unchanged. The recognition engine treats `allocatedAmount IS NULL`
-- as "fall back to SSP" — preserving the v0.2 semantics for any code
-- that doesn't yet populate the new field.
--
-- Run via:
--   npx prisma db execute --file prisma/sql/2026-06-04-po-schema-additions.sql --schema prisma/schema.prisma
--
-- Idempotent: every ALTER uses IF NOT EXISTS / DO blocks; safe to
-- re-run after a partial failure.

-- 1. AllocationMethod enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AllocationMethod') THEN
    CREATE TYPE "AllocationMethod" AS ENUM ('PROPORTIONAL', 'RESIDUAL', 'MANUAL');
  END IF;
END $$;

-- 2. FairValueMethod enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FairValueMethod') THEN
    CREATE TYPE "FairValueMethod" AS ENUM ('ESP', 'VSOE', 'TPE', 'RESIDUAL');
  END IF;
END $$;

-- 3. allocatedAmount column (NULL means "use SSP" — back-compat)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "allocatedAmount" DECIMAL(18,4);

-- 4. allocationMethod column (NULL = unspecified)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "allocationMethod" "AllocationMethod";

-- 5. fairValueMethod column (NULL = unspecified)
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "fairValueMethod" "FairValueMethod";

-- 6. quantity column (DEFAULT 1 means "back-compat with SSP-as-line-total")
ALTER TABLE performance_obligation
  ADD COLUMN IF NOT EXISTS "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1;
