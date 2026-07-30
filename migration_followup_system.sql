-- Follow-up system schema additions
-- Run this once in your Supabase SQL Editor before deploying the new server code.
-- Safe to re-run: every column uses IF NOT EXISTS.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS contact_outcome TEXT,
  ADD COLUMN IF NOT EXISTS attempt_history JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS follow_up_attempts INTEGER DEFAULT 0;
