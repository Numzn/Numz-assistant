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
  },
  {
    version: 3,
    name: 'committed segment counts for completion checks; closed meetings are immutable in the database',
    run(database) {
      // committed_segments: how many final segments the session says it produced (NULL = never reported).
      // The triggers back the service-level rules: even a buggy writer cannot add to, edit, or reopen a
      // closed meeting. They raise instead of silently ignoring the write.
      database.exec(`
        ALTER TABLE speech_sessions ADD COLUMN committed_segments INTEGER;

        CREATE TRIGGER trg_closed_meeting_takes_no_segments
        BEFORE INSERT ON transcript_segments
        WHEN (SELECT status FROM meetings WHERE meeting_id = NEW.meeting_id) IN ('COMPLETED', 'FAILED', 'CANCELLED')
        BEGIN
          SELECT RAISE(ABORT, 'meeting-closed');
        END;

        CREATE TRIGGER trg_closed_meeting_segments_are_not_edited
        BEFORE UPDATE ON transcript_segments
        WHEN (SELECT status FROM meetings WHERE meeting_id = OLD.meeting_id) IN ('COMPLETED', 'FAILED', 'CANCELLED')
        BEGIN
          SELECT RAISE(ABORT, 'meeting-closed');
        END;

        CREATE TRIGGER trg_closed_meeting_takes_no_sessions
        BEFORE INSERT ON speech_sessions
        WHEN (SELECT status FROM meetings WHERE meeting_id = NEW.meeting_id) IN ('COMPLETED', 'FAILED', 'CANCELLED')
        BEGIN
          SELECT RAISE(ABORT, 'meeting-closed');
        END;

        CREATE TRIGGER trg_closed_meeting_never_reopens
        BEFORE UPDATE OF status ON meetings
        WHEN OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND NEW.status <> OLD.status
        BEGIN
          SELECT RAISE(ABORT, 'meeting-terminal');
        END;
      `)
    }
  },
  {
    version: 4,
    name: 'assistant conversation history',
    run(database) {
      // A conversation is an assistant session that has had at least one message (empty sessions are never
      // stored). conversation_id is the session id. Messages are ordered by seq; deleting a conversation
      // deletes its messages. Plain tables: nothing here touches meetings or transcripts.
      database.exec(`
        CREATE TABLE assistant_conversations (
          conversation_id TEXT PRIMARY KEY,
          title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE assistant_messages (
          conversation_id TEXT NOT NULL REFERENCES assistant_conversations(conversation_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, seq)
        );

        CREATE INDEX idx_assistant_conversations_updated ON assistant_conversations(updated_at DESC);
      `)
    }
  },
  {
    version: 5,
    name: 'people and their sessions',
    run(database) {
      // NUMZ AI 2.0: the people who use the assistant, their own sessions, and the security audit trail.
      // external_id is the NUMZLAB user id (stable for life, see numzlab-auth); it is the identity key.
      // Nothing here ever holds a cookie secret (only its SHA-256), a prompt, a reply or an attachment.
      database.exec(`
        CREATE TABLE ai_users (
          id TEXT PRIMARY KEY,
          external_provider TEXT NOT NULL DEFAULT 'numzlab',
          external_id TEXT NOT NULL,
          email TEXT NOT NULL,
          name TEXT,
          role TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          created_at TEXT NOT NULL,
          last_login_at TEXT,
          last_verified_at TEXT,
          UNIQUE (external_provider, external_id)
        );

        CREATE TABLE ai_sessions (
          id_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES ai_users(id),
          csrf TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          ip TEXT,
          user_agent_hash TEXT,
          revoked_at INTEGER,
          revoked_reason TEXT
        );
        CREATE INDEX idx_ai_sessions_user ON ai_sessions(user_id);

        CREATE TABLE ai_user_settings (
          user_id TEXT PRIMARY KEY REFERENCES ai_users(id) ON DELETE CASCADE,
          settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE ai_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          event TEXT NOT NULL,
          user_id TEXT,
          session_ref TEXT,
          ip TEXT,
          request_id TEXT,
          detail_json TEXT
        );
        CREATE INDEX idx_ai_audit_ts ON ai_audit(ts);
      `)
    }
  },
  {
    version: 6,
    name: 'conversation ownership',
    run(database) {
      // Every conversation belongs to one person. Rows that exist today have no owner (NULL): they are QUARANTINED. A person's
      // queries always say owner_user_id = ?, which can never match NULL, so nobody sees them until the administrator releases them
      // on the host (scripts/ai-admin.js legacy claim). Additive only: an older server image simply ignores the new columns.
      database.exec(`
        ALTER TABLE assistant_conversations ADD COLUMN owner_user_id TEXT REFERENCES ai_users(id);
        ALTER TABLE assistant_conversations ADD COLUMN origin TEXT;
        CREATE INDEX idx_assistant_conversations_owner ON assistant_conversations(owner_user_id, updated_at DESC);

        CREATE TRIGGER trg_conversation_owner_is_permanent
        BEFORE UPDATE OF owner_user_id ON assistant_conversations
        WHEN OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT OLD.owner_user_id
        BEGIN
          SELECT RAISE(ABORT, 'conversation-owner-is-permanent');
        END;
      `)
    }
  },
  {
    version: 7,
    name: 'usage records and runtime switches',
    run(database) {
      // One row per cost-bearing call, for the person who made it. Counts and sizes only: never any text, image or audio.
      // user_id is deliberately not a foreign key: the single-tenant fallback records its calls as 'legacy'.
      database.exec(`
        CREATE TABLE ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          tokens_in INTEGER,
          tokens_out INTEGER,
          audio_seconds REAL,
          images INTEGER,
          est_cost_micro_usd INTEGER,
          status TEXT NOT NULL,
          duration_ms INTEGER,
          request_id TEXT,
          conversation_id TEXT
        );
        CREATE INDEX idx_ai_usage_user_ts ON ai_usage(user_id, ts);
        CREATE INDEX idx_ai_usage_ts ON ai_usage(ts);

        CREATE TABLE ai_runtime_flags (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT
        );
      `)
    }
  }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Applies every pending migration. Safe to call on an already-migrated database.
 * `target` stops at an earlier version, which lets a test build an old database and upgrade it.
 */
export function applyMigrations(database, { target = SCHEMA_VERSION } = {}) {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version))

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version) || migration.version > target) continue
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
