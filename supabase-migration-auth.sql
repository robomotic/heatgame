-- Migration: replace fingerprint with Supabase Auth user_id
-- Run in Supabase SQL Editor → New Query → Run

-- Add user_id column (UUID string from Supabase Auth)
ALTER TABLE scores ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Drop old fingerprint column and index if they exist
DROP INDEX IF EXISTS idx_fingerprint_country;
ALTER TABLE scores DROP COLUMN IF EXISTS fingerprint;
ALTER TABLE scores DROP COLUMN IF EXISTS player_ip;

-- Index for fast personal-best lookups (used on every submit)
CREATE INDEX IF NOT EXISTS idx_user_country ON scores (user_id, country);

-- Update RLS: anyone can read; only authenticated users can insert/update their own rows
DROP POLICY IF EXISTS "public read" ON scores;
CREATE POLICY "public read"  ON scores FOR SELECT TO anon  USING (true);
CREATE POLICY "auth insert"  ON scores FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid()::text);
CREATE POLICY "auth update"  ON scores FOR UPDATE TO authenticated USING     (user_id = auth.uid()::text);
