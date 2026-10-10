import { randomUUID } from 'node:crypto'
import {
  MEETING_STATES as S,
  MeetingDomainError,
  SESSION_ATTACHABLE_STATES,
  SPEECH_SESSION_END_REASONS,
  TRANSCRIPT_ACCEPTING_STATES,
  assertTransition,
  isRecoverableMeetingStatus,
  transitionMeeting
} from '../meetings/meetingDomain.js'
import { validateFinalSegment } from '../meetings/segmentValidation.js'

/**
 * Meeting lifecycle, speech sessions and canonical transcript persistence.
 *
 * Timeline contract (see docs/transcript-schema.md):
 *   meeting time = session.timelineOffsetMs + session-relative time
 * The offset is fixed when a speech session attaches: max(wall-clock time since the
 * meeting went LIVE, latest stored segment end). Offsets therefore never go backwards.
 */
export function createMeetingSessionService({
  meetingRepository,
  speechSessionRepository,
  transcriptRepository,
  eventBus,
  clock = () => Date.now()
} = {}) {
  if (!meetingRepository || !speechSessionRepository || !transcriptRepository) {
    throw new Error('meeting repositories are required')
  }

  const nowIso = () => new Date(clock()).toISOString()

  function emit(type, data) {
    eventBus?.emit?.(type, data)
  }

  function getRequired(meetingId) {
    const meeting = meetingRepository.getById(meetingId)
    if (!meeting) throw new MeetingDomainError('Meeting not found', { statusCode: 404, code: 'meeting-not-found' })
    return meeting
  }

  function getSessionForMeeting(meetingId, speechSessionId) {
    if (typeof speechSessionId !== 'string' || !speechSessionId) {
      throw new MeetingDomainError('speechSessionId is required', { statusCode: 400, code: 'invalid-speech-session-id' })
    }
    const session = speechSessionRepository.getById(speechSessionId)
    if (!session || session.meetingId !== meetingId) {
      throw new MeetingDomainError('Speech session not found for this meeting', {
        statusCode: 404,
        code: 'speech-session-not-found'
      })
    }
    return session
  }

  function move(meetingId, status, { reason } = {}) {
    const meeting = getRequired(meetingId)
    let next = transitionMeeting(meeting, status, nowIso())
    if (next === meeting) return meeting // already there: nothing to save and nothing to announce
    if (reason) next = { ...next, metadata: { ...next.metadata, closeReason: reason } }
    meetingRepository.save(next)
    emit(`Meeting${status[0]}${status.slice(1).toLowerCase()}`, { meetingId, status })
    return next
  }

  const MAX_COMMITTED_SEGMENTS = 10_000_000
  const MAX_CLOSE_REASON_LENGTH = 200

  function committedCountFrom(value) {
    if (value === undefined || value === null) return null
    if (!Number.isInteger(value) || value < 0 || value > MAX_COMMITTED_SEGMENTS) {
      throw new MeetingDomainError('committedSegments must be a non-negative integer', {
        statusCode: 400,
        code: 'invalid-committed-segments'
      })
    }
    return value
  }

  function closeReasonFrom(reason) {
    if (reason === undefined || reason === null) return undefined
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_CLOSE_REASON_LENGTH) {
      throw new MeetingDomainError(`reason must be a non-empty string of at most ${MAX_CLOSE_REASON_LENGTH} characters`, {
        statusCode: 400,
        code: 'invalid-close-reason'
      })
    }
    return reason.trim()
  }

  /**
   * Compares what each speech session says it committed with what is stored.
   *   VERIFIED     reported count equals stored count
   *   INCOMPLETE   reported more than stored: segments are missing (known loss)
   *   INCONSISTENT stored more than reported: the report cannot be trusted
   *   OPEN         the session is still active and has produced transcript
   *   UNVERIFIED   no report. Whether or not anything is stored, the transport may be holding committed
   *                segments it could not deliver (for example the API was down for the whole session, or
   *                the transport crashed), and this service cannot see them. Never treated as empty.
   * `complete` means no known loss and nothing still streaming. `verified` additionally means
   * no session is left unverified.
   */
  function computeIntegrity(meetingId) {
    const stored = transcriptRepository.countBySession(meetingId)
    const sessions = speechSessionRepository.getByMeeting(meetingId).map((session) => {
      const storedSegments = stored[session.speechSessionId] ?? 0
      const committed = session.committedSegments
      let state
      if (committed !== null) {
        state = storedSegments === committed ? 'VERIFIED' : storedSegments < committed ? 'INCOMPLETE' : 'INCONSISTENT'
      } else if (session.status === 'ACTIVE') {
        // Still streaming: its last lines may be on their way even when none is stored yet (the
        // recognizer can run behind the speaker). Ending now would refuse them, so this blocks /end.
        state = 'OPEN'
      } else {
        state = 'UNVERIFIED'
      }
      return {
        speechSessionId: session.speechSessionId,
        status: session.status,
        endReason: session.endReason,
        committedSegments: committed,
        storedSegments,
        missingSegments: committed === null ? null : Math.max(0, committed - storedSegments),
        state
      }
    })
    const blocking = sessions.filter((entry) => ['INCOMPLETE', 'INCONSISTENT', 'OPEN'].includes(entry.state))
    const unverified = sessions.filter((entry) => entry.state === 'UNVERIFIED').length
    return {
      complete: blocking.length === 0,
      verified: blocking.length === 0 && unverified === 0,
      unverifiedSessions: unverified,
      missingSegments: sessions.reduce((sum, entry) => sum + (entry.missingSegments ?? 0), 0),
      sessions
    }
  }

  /** Refuses to close a meeting whose transcript is known to be incomplete. Nothing changes when it throws. */
  function assertTranscriptComplete(meetingId) {
    const integrity = computeIntegrity(meetingId)
    if (integrity.sessions.some((entry) => entry.state === 'OPEN')) {
      throw new MeetingDomainError('A speech session is still streaming transcript. End it before ending the meeting.', {
        statusCode: 409,
        code: 'speech-session-active',
        details: integrity
      })
    }
    if (!integrity.complete) {
      throw new MeetingDomainError(
        `The transcript is incomplete: ${integrity.missingSegments} committed segment(s) are not stored. ` +
          'Deliver them (replay the transport outbox) or mark the meeting failed.',
        { statusCode: 409, code: 'transcript-incomplete', details: integrity }
      )
    }
    return integrity
  }

  function completeMeeting(meetingId) {
    assertTransition(getRequired(meetingId).status, S.COMPLETED)
    assertTranscriptComplete(meetingId)
    endActiveSessions(meetingId, 'meeting-completed')
    const completed = move(meetingId, S.COMPLETED)
    return { ...completed, integrity: computeIntegrity(meetingId) }
  }

  function timelineOffsetFor(meeting, nowMs) {
    const startedMs = meeting.startedAt ? Date.parse(meeting.startedAt) : nowMs
    const elapsedMs = Math.max(0, nowMs - startedMs)
    return Math.round(Math.max(elapsedMs, transcriptRepository.maxEndMs(meeting.meetingId)))
  }

  /** Supersedes any ACTIVE session (one live connection per meeting) and opens a new one on the meeting timeline. */
  function openSpeechSession(meeting) {
    const nowMs = clock()
    const now = new Date(nowMs).toISOString()
    for (const active of speechSessionRepository.getActiveByMeeting(meeting.meetingId)) {
      speechSessionRepository.end({ speechSessionId: active.speechSessionId, reason: 'superseded', now })
      emit('SpeechSessionEnded', { meetingId: meeting.meetingId, speechSessionId: active.speechSessionId, reason: 'superseded' })
    }
    const timelineOffsetMs = timelineOffsetFor(meeting, nowMs)
    const session = speechSessionRepository.create({ meetingId: meeting.meetingId, now, timelineOffsetMs })
    emit('SpeechSessionStarted', {
      meetingId: meeting.meetingId,
      speechSessionId: session.speechSessionId,
      timelineOffsetMs
    })
    return session
  }

  function endActiveSessions(meetingId, reason) {
    const now = nowIso()
    for (const active of speechSessionRepository.getActiveByMeeting(meetingId)) {
      speechSessionRepository.end({ speechSessionId: active.speechSessionId, reason, now })
    }
  }

  /** Maps a session-relative segment onto the meeting timeline. Word times are shifted too. */
  function toMeetingTimeline(segment, { speechSessionId, offsetMs }) {
    const toMs = (seconds) => Math.round(seconds * 1000)
    const shiftWord = (word) =>
      word && typeof word === 'object' && Number.isFinite(word.start) && Number.isFinite(word.end)
        ? { ...word, start: (offsetMs + toMs(word.start)) / 1000, end: (offsetMs + toMs(word.end)) / 1000 }
        : word
    return {
      id: segment.id,
      start: (offsetMs + toMs(segment.start)) / 1000,
      end: (offsetMs + toMs(segment.end)) / 1000,
      text: segment.text.trim(),
      speaker: segment.speaker ?? null,
      speakerConfidence: segment.speakerConfidence ?? null,
      words: (segment.words ?? []).map(shiftWord),
      confidence: segment.confidence ?? null,
      language: segment.language ?? null,
      uncertain: segment.uncertain,
      timeline: 'meeting',
      speechSessionId,
      sessionStart: segment.start,
      sessionEnd: segment.end
    }
  }

  return {
    createMeeting(metadata = {}) {
      const meeting = meetingRepository.create({ meetingId: randomUUID(), metadata, now: nowIso() })
      emit('MeetingCreated', { meetingId: meeting.meetingId })
      return meeting
    },

    getMeeting: getRequired,

    /**
     * The meeting still being captured that was started by this launch attempt, or null. Lets a repeated
     * start (a double trigger, a retry after a lost answer) return the same meeting instead of making another.
     * A meeting that has ended, failed or been cancelled is never handed out again.
     */
    findActiveByLaunchKey(launchKey) {
      if (typeof launchKey !== 'string' || !launchKey) return null
      return meetingRepository.getActiveMeetings().find((meeting) => meeting.metadata?.launchKey === launchKey) ?? null
    },

    /** Makes the meeting LIVE. It creates no speech session: each transport connection attaches its own. */
    startMeeting(meetingId) {
      move(meetingId, S.STARTING)
      return move(meetingId, S.LIVE)
    },

    pauseMeeting(meetingId) {
      return move(meetingId, S.PAUSED)
    },

    resumeMeeting(meetingId) {
      return move(meetingId, S.LIVE)
    },

    recoverMeeting(meetingId) {
      const meeting = getRequired(meetingId)
      if (!isRecoverableMeetingStatus(meeting.status)) {
        throw new MeetingDomainError(`Meeting is not recoverable from ${meeting.status}`, {
          statusCode: 409,
          code: 'meeting-not-recoverable'
        })
      }
      return meeting.status === S.RECOVERING ? meeting : move(meetingId, S.RECOVERING)
    },

    /**
     * Startup policy: no live connection survives a process restart, so every ACTIVE speech
     * session ends ('process-restart') and every STARTING/LIVE/PAUSED meeting becomes RECOVERING.
     * Persisted segments are untouched. Audio buffers and in-flight ASR are not restored.
     */
    recoverInterruptedMeetings() {
      const now = nowIso()
      let endedSessions = 0
      for (const session of speechSessionRepository.listActive()) {
        if (speechSessionRepository.end({ speechSessionId: session.speechSessionId, reason: 'process-restart', now })) {
          endedSessions += 1
        }
      }
      let recoveredMeetings = 0
      for (const meeting of meetingRepository.findByStatus([S.STARTING, S.LIVE, S.PAUSED])) {
        move(meeting.meetingId, S.RECOVERING)
        recoveredMeetings += 1
      }
      return { endedSessions, recoveredMeetings }
    },

    attachSpeechSession(meetingId) {
      const meeting = getRequired(meetingId)
      if (!SESSION_ATTACHABLE_STATES.has(meeting.status)) {
        throw new MeetingDomainError(`Cannot attach speech session to ${meeting.status}`, {
          statusCode: 409,
          code: 'meeting-not-attachable'
        })
      }
      return openSpeechSession(meeting)
    },

    /**
     * Ends a session. `committedSegments` is how many final segments the transport produced, which lets
     * the API tell a complete transcript from one with segments still missing. A session that already
     * ended (for example superseded before its transport could report) still accepts its first report.
     */
    endSpeechSession(meetingId, speechSessionId, reason, { committedSegments } = {}) {
      if (!SPEECH_SESSION_END_REASONS.includes(reason)) {
        throw new MeetingDomainError(`reason must be one of: ${SPEECH_SESSION_END_REASONS.join(', ')}`, {
          statusCode: 400,
          code: 'invalid-end-reason'
        })
      }
      const committed = committedCountFrom(committedSegments)
      getRequired(meetingId)
      const session = getSessionForMeeting(meetingId, speechSessionId)
      if (session.status !== 'ACTIVE') {
        if (committed !== null) {
          speechSessionRepository.recordCommitted({ speechSessionId, committedSegments: committed, now: nowIso() })
        }
        return speechSessionRepository.getById(speechSessionId)
      }
      speechSessionRepository.end({ speechSessionId, reason, now: nowIso(), committedSegments: committed })
      emit('SpeechSessionEnded', { meetingId, speechSessionId, reason })
      return speechSessionRepository.getById(speechSessionId)
    },

    listSpeechSessions(meetingId) {
      getRequired(meetingId)
      const stored = transcriptRepository.countBySession(meetingId)
      return speechSessionRepository
        .getByMeeting(meetingId)
        .map((session) => ({ ...session, storedSegments: stored[session.speechSessionId] ?? 0 }))
    },

    /** The completeness report for a meeting's transcript (see computeIntegrity). */
    getIntegrity(meetingId) {
      getRequired(meetingId)
      return computeIntegrity(meetingId)
    },

    beginFinalization(meetingId) {
      return move(meetingId, S.FINALIZING)
    },

    /**
     * Ends a meeting: FINALIZING, then COMPLETED. The completeness check runs first, so a refusal
     * leaves the meeting exactly as it was and capture can continue.
     */
    endMeeting(meetingId) {
      const meeting = getRequired(meetingId)
      assertTransition(meeting.status, S.FINALIZING)
      assertTranscriptComplete(meetingId)
      if (meeting.status !== S.FINALIZING) move(meetingId, S.FINALIZING)
      return completeMeeting(meetingId)
    },

    /** COMPLETED means no known loss: it is refused while segments are missing or a stream is open. */
    completeMeeting,

    /** Abandons a meeting on purpose. Stored segments stay readable; nothing more is accepted. */
    cancelMeeting(meetingId, { reason } = {}) {
      const closeReason = closeReasonFrom(reason)
      assertTransition(getRequired(meetingId).status, S.CANCELLED)
      endActiveSessions(meetingId, 'stopped')
      return move(meetingId, S.CANCELLED, { reason: closeReason })
    },

    /** Marks a meeting failed, for example when its transcript can never be made complete. */
    failMeeting(meetingId, { reason } = {}) {
      const closeReason = closeReasonFrom(reason)
      assertTransition(getRequired(meetingId).status, S.FAILED)
      endActiveSessions(meetingId, 'error')
      return move(meetingId, S.FAILED, { reason: closeReason })
    },

    /**
     * Persists one FINAL canonical segment for an explicit speech session: { speechSessionId, segment }.
     * Identity is never guessed: a segment that does not name its session is refused.
     *
     * Returns { status, inserted, segment } where status is INSERTED | ALREADY_EXISTS | CONFLICT.
     * CONFLICT is returned, never converted to success.
     */
    appendFinalSegment(meetingId, { speechSessionId, segment } = {}) {
      const meeting = getRequired(meetingId)

      if (!TRANSCRIPT_ACCEPTING_STATES.has(meeting.status)) {
        throw new MeetingDomainError(`Meeting is ${meeting.status} and does not accept transcript segments`, {
          statusCode: 409,
          code: 'meeting-not-accepting-transcript'
        })
      }

      const session = getSessionForMeeting(meetingId, speechSessionId)
      const valid = validateFinalSegment(segment)
      const canonical = toMeetingTimeline(valid, {
        speechSessionId: session.speechSessionId,
        offsetMs: session.timelineOffsetMs
      })
      const result = transcriptRepository.insertFinalSegment({
        meetingId,
        speechSessionId: session.speechSessionId,
        canonical,
        now: nowIso()
      })
      emit('TranscriptSegmentPersisted', { meetingId, segmentId: canonical.id, status: result.status, segment: result.segment })
      return { status: result.status, inserted: result.status === 'INSERTED', segment: result.segment }
    },

    getTranscript(meetingId) {
      getRequired(meetingId)
      return transcriptRepository.getByMeeting(meetingId)
    }
  }
}

export { assertTransition }
