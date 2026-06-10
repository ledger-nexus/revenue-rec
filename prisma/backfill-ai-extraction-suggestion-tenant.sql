-- Backfill AiExtractionSuggestion.tenant_id from the contract chain:
--   AiExtractionSuggestion.contract_id
--     → revenue_contract.entity_id
--     → legal_entity.tenant_id
--
-- Run AFTER `pnpm db:push` adds the nullable tenant_id column.
-- Idempotent — only updates rows where tenant_id IS NULL.
--
-- Every existing row will be backfilled because contract_id is required
-- (NOT NULL on the column). New rows are stamped by
-- extractContractAction.

UPDATE ai_extraction_suggestion AS s
SET tenant_id = e.tenant_id
FROM revenue_contract AS c
JOIN legal_entity AS e ON c.entity_id = e.id
WHERE s.contract_id = c.id
  AND s.tenant_id IS NULL;

-- Verify: this should return 0.
-- SELECT COUNT(*) FROM ai_extraction_suggestion WHERE tenant_id IS NULL;
