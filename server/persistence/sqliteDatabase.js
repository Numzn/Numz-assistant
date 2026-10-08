import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 1

const schemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  meeting_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS speech_sessions (
  speech_session_id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_speech_sessions_meeting ON speech_sessions(meeting_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
  segment_id TEXT NOT NULL,
  speaker_id TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  is_final INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  segment_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, segment_id)
);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_chronology
  ON transcript_segments(meeting_id, start_ms, end_ms, segment_id);
`

export function createDatabase({ filename = process.env.SPEECH_DATABASE_PATH ?? './data/speech.sqlite' } = {}) {
  const resolved = filename === ':memory:' ? filename : path.resolve(filename)
  if (resolved !== ':memory:') mkdirSync(path.dirname(resolved), { recursive: true })
  const database = new DatabaseSync(resolved)
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec(schemaSql)
  const migration = database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION)
  if (!migration) {
    database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      new Date().toISOString()
    )
  }
  return database
}

export { SCHEMA_VERSION }
