-- Follow-up system schema additions
-- Run this once in your Supabase SQL Editor before deploying the new server code.
-- Safe to re-run: every column uses IF NOT EXISTS.
-- If you already ran the first version of this file, re-running it is still
-- safe — it will only add the two new columns (call_summary, notifications).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_outcome TEXT,
  ADD COLUMN IF NOT EXISTS attempt_history JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS follow_up_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS call_summary TEXT,
  ADD COLUMN IF NOT EXISTS notifications JSONB DEFAULT '[]'::jsonb;
