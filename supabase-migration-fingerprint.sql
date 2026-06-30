-- Run in Supabase SQL Editor to add fingerprint support
-- Supabase dashboard → SQL Editor → New Query → paste → Run

ALTER TABLE scores ADD COLUMN IF NOT EXISTS fingerprint TEXT;

-- Index for fast fingerprint+country lookups (used on every submit)
CREATE INDEX IF NOT EXISTS idx_fingerprint_country ON scores (fingerprint, country);
