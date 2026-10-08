import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { contentHash } from './canonicalJson.js'

/**
 * Schema is managed by numbered, additive migrations. Each migration runs in its
 * own transaction and is recorded in schema_migrations. Never edit an applied
 * migration; add a new one instead.
 */
const V1_SCHEMA = `
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

function backfillContentHashes(database) {
  const rows = database
    .prepare('SELECT meeting_id, segment_id, segment_json FROM transcript_segments WHERE content_hash IS NULL')
    .all()
  const update = database.prepare(
    'UPDATE transcript_segments SET content_hash = ? WHERE meeting_id = ? AND segment_id = ?'
  )
  for (const row of rows) {
    update.run(contentHash(JSON.parse(row.segment_json)), row.meeting_id, row.segment_id)
  }
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial meeting and transcript schema',
    run(database) {
      database.exec(V1_SCHEMA)
    }
  },
  {
    version: 2,
    name: 'meeting timeline offset, content hash for idempotency, session end reason',
    run(database) {
      database.exec(`
        ALTER TABLE speech_sessions ADD COLUMN timeline_offset_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE speech_sessions ADD COLUMN end_reason TEXT;
        ALTER TABLE transcript_segments ADD COLUMN content_hash TEXT;
        ALTER TABLE transcript_segments ADD COLUMN speech_session_id TEXT REFERENCES speech_sessions(speech_session_id);
        CREATE INDEX IF NOT EXISTS idx_speech_sessions_meeting_status ON speech_sessions(meeting_id, status);
        CREATE INDEX IF NOT EXISTS idx_speech_sessions_status ON speech_sessions(status);
      `)
      backfillContentHashes(database)
    }
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/** Applies every pending migration. Safe to call on an already-migrated database. */
export function applyMigrations(database) {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      migration.run(database)
      database
        .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString())
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  }
  return database
}

export function createDatabase({ filename = process.env.SPEECH_DATABASE_PATH ?? './data/speech.sqlite' } = {}) {
  const resolved = filename === ':memory:' ? filename : path.resolve(filename)
  if (resolved !== ':memory:') mkdirSync(path.dirname(resolved), { recursive: true })
  const database = new DatabaseSync(resolved)
  database.exec('PRAGMA busy_timeout = 5000;')
  return applyMigrations(database)
}
