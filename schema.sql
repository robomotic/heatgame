-- Run once to create the leaderboard table in Cloudflare D1
-- Command: wrangler d1 execute heatwave-scores --file=schema.sql

CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player     TEXT    NOT NULL,
  country    TEXT    NOT NULL,
  deaths     INTEGER NOT NULL,
  co2_pct    REAL    NOT NULL,
  econ_loss  REAL    NOT NULL,
  approval   INTEGER NOT NULL,
  ending     TEXT    NOT NULL,
  score      INTEGER NOT NULL,
  created_at TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_score   ON scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_country ON scores(country);
