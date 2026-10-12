-- Run as a standalone statement outside a transaction, after shared staging fields.
-- Operator sets session lock_timeout=2s and statement_timeout=60s before execution.
-- IF NOT EXISTS is restart-safe only with the following attestation migration:
-- a same-name invalid or differently defined index must never enable the worker.
create index concurrently if not exists ingestion_staged_rows_page_idx
  on public.ingestion_staged_rows(job_id,kind,page_position);
