-- The Burrow — initial persistence schema (spec §20)

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  secured_gems INTEGER NOT NULL DEFAULT 0,
  progression_level INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS unlocks (
  player_id TEXT NOT NULL,
  unlock_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, unlock_id)
);

CREATE TABLE IF NOT EXISTS loadouts (
  player_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (player_id, slot)
);

CREATE TABLE IF NOT EXISTS match_history (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  role TEXT NOT NULL,
  result TEXT NOT NULL,
  captures INTEGER NOT NULL DEFAULT 0,
  secured_gems INTEGER NOT NULL DEFAULT 0,
  survived_seconds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_match_history_player ON match_history (player_id, created_at);
