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

  function move(meetingId, status) {
    const meeting = getRequired(meetingId)
    const next = transitionMeeting(meeting, status, nowIso())
    meetingRepository.save(next)
    emit(`Meeting${status[0]}${status.slice(1).toLowerCase()}`, { meetingId, status })
    return next
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

    startMeeting(meetingId) {
      move(meetingId, S.STARTING)
      const meeting = move(meetingId, S.LIVE)
      const speechSession = openSpeechSession(meeting)
      return { meeting, speechSession }
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

    endSpeechSession(meetingId, speechSessionId, reason) {
      if (!SPEECH_SESSION_END_REASONS.includes(reason)) {
        throw new MeetingDomainError(`reason must be one of: ${SPEECH_SESSION_END_REASONS.join(', ')}`, {
          statusCode: 400,
          code: 'invalid-end-reason'
        })
      }
      getRequired(meetingId)
      const session = getSessionForMeeting(meetingId, speechSessionId)
      if (session.status !== 'ACTIVE') return session
      speechSessionRepository.end({ speechSessionId, reason, now: nowIso() })
      emit('SpeechSessionEnded', { meetingId, speechSessionId, reason })
      return speechSessionRepository.getById(speechSessionId)
    },

    listSpeechSessions(meetingId) {
      getRequired(meetingId)
      return speechSessionRepository.getByMeeting(meetingId)
    },

    beginFinalization(meetingId) {
      return move(meetingId, S.FINALIZING)
    },

    completeMeeting(meetingId) {
      assertTransition(getRequired(meetingId).status, S.COMPLETED)
      endActiveSessions(meetingId, 'meeting-completed')
      return move(meetingId, S.COMPLETED)
    },

    cancelMeeting(meetingId) {
      assertTransition(getRequired(meetingId).status, S.CANCELLED)
      endActiveSessions(meetingId, 'stopped')
      return move(meetingId, S.CANCELLED)
    },

    failMeeting(meetingId) {
      assertTransition(getRequired(meetingId).status, S.FAILED)
      endActiveSessions(meetingId, 'error')
      return move(meetingId, S.FAILED)
    },

    /**
     * Persists one FINAL canonical segment. Accepts { speechSessionId, segment }, or a bare
     * segment for compatibility (routed to the meeting's most recent ACTIVE session).
     *
     * Returns { status, inserted, segment } where status is INSERTED | ALREADY_EXISTS | CONFLICT.
     * CONFLICT is returned, never converted to success.
     */
    appendFinalSegment(meetingId, input) {
      const meeting = getRequired(meetingId)
      let speechSessionId
      let segment
      if (input && typeof input === 'object' && 'segment' in input) {
        ;({ speechSessionId, segment } = input)
      } else {
        segment = input
        const active = speechSessionRepository.getActiveByMeeting(meetingId)
        if (active.length === 0) {
          throw new MeetingDomainError('Meeting has no active speech session', {
            statusCode: 409,
            code: 'no-active-speech-session'
          })
        }
        speechSessionId = active[active.length - 1].speechSessionId
      }

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
      emit('TranscriptSegmentPersisted', { meetingId, segmentId: canonical.id, status: result.status })
      return { status: result.status, inserted: result.status === 'INSERTED', segment: result.segment }
    },

    getTranscript(meetingId) {
      getRequired(meetingId)
      return transcriptRepository.getByMeeting(meetingId)
    }
  }
}

export { assertTransition }
