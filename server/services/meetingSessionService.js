import { randomUUID } from 'node:crypto'
import {
  MEETING_STATES,
  assertTransition,
  createMeeting,
  isRecoverableMeetingStatus,
  transitionMeeting
} from '../meetings/meetingDomain.js'

export function createMeetingSessionService({ meetingRepository, speechSessionRepository, transcriptRepository, eventBus } = {}) {
  if (!meetingRepository || !speechSessionRepository || !transcriptRepository) {
    throw new Error('meeting repositories are required')
  }

  function emit(type, data) {
    eventBus?.emit?.(type, data)
  }

  function getRequired(meetingId) {
    const meeting = meetingRepository.getById(meetingId)
    if (!meeting) {
      const error = new Error('Meeting not found')
      error.statusCode = 404
      throw error
    }
    return meeting
  }

  function move(meetingId, status) {
    const meeting = getRequired(meetingId)
    const next = transitionMeeting(meeting, status)
    meetingRepository.save(next)
    emit(`Meeting${status[0]}${status.slice(1).toLowerCase()}`, { meetingId, status })
    return next
  }

  return {
    createMeeting(metadata = {}) {
      const meeting = meetingRepository.create({ meetingId: randomUUID(), metadata })
      emit('MeetingCreated', { meetingId: meeting.meetingId })
      return meeting
    },
    getMeeting: getRequired,
    startMeeting(meetingId) {
      let meeting = move(meetingId, MEETING_STATES.STARTING)
      meeting = move(meetingId, MEETING_STATES.LIVE)
      const speechSession = speechSessionRepository.create({ meetingId })
      return { meeting, speechSession }
    },
    pauseMeeting(meetingId) {
      return move(meetingId, MEETING_STATES.PAUSED)
    },
    resumeMeeting(meetingId) {
      return move(meetingId, MEETING_STATES.LIVE)
    },
    recoverMeeting(meetingId) {
      const meeting = getRequired(meetingId)
      if (!isRecoverableMeetingStatus(meeting.status)) {
        const error = new Error(`Meeting is not recoverable from ${meeting.status}`)
        error.statusCode = 409
        throw error
      }
      const recovered = meeting.status === MEETING_STATES.RECOVERING
        ? meeting
        : transitionMeeting(meeting, MEETING_STATES.RECOVERING)
      meetingRepository.save(recovered)
      emit('MeetingRecovering', { meetingId })
      return recovered
    },
    attachSpeechSession(meetingId) {
      const meeting = getRequired(meetingId)
      if (![MEETING_STATES.LIVE, MEETING_STATES.RECOVERING, MEETING_STATES.STARTING].includes(meeting.status)) {
        const error = new Error(`Cannot attach speech session to ${meeting.status}`)
        error.statusCode = 409
        throw error
      }
      return speechSessionRepository.create({ meetingId })
    },
    beginFinalization(meetingId) {
      return move(meetingId, MEETING_STATES.FINALIZING)
    },
    completeMeeting(meetingId) {
      return move(meetingId, MEETING_STATES.COMPLETED)
    },
    cancelMeeting(meetingId) {
      return move(meetingId, MEETING_STATES.CANCELLED)
    },
    failMeeting(meetingId) {
      return move(meetingId, MEETING_STATES.FAILED)
    },
    appendFinalSegment(meetingId, segment) {
      getRequired(meetingId)
      const result = transcriptRepository.appendFinalSegment(meetingId, segment)
      emit('TranscriptSegmentPersisted', { meetingId, segmentId: segment.id, inserted: result.inserted })
      return result
    },
    getTranscript(meetingId) {
      getRequired(meetingId)
      return transcriptRepository.getByMeeting(meetingId)
    }
  }
}

export { assertTransition }
