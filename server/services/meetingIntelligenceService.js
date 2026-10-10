import { MeetingDomainError } from '../meetings/meetingDomain.js'
import { extractSignals } from '../intelligence/meetingSignals.js'
import { groundNotes } from '../intelligence/grounding.js'

/**
 * Meeting intelligence over the SAVED transcript, and only that: the caller names a meeting, never supplies text.
 *
 *   signals(meetingId)        questions / action items / decisions found in the words themselves. No model, no
 *                             cost, available at any time and labelled with how settled the transcript is.
 *   notes(meetingId, opts)    a model's summary and notes, every item checked against the transcript it was
 *                             given (see intelligence/grounding.js). Refused until the transcript is final.
 *
 * Every answer carries `transcript.state`, so nothing derived from a transcript that may still change, or may
 * be missing lines, reads as settled:
 *   verified    the meeting is COMPLETED and every recording confirmed how many lines it produced
 *   unverified  COMPLETED, but a recording never confirmed its count (lines may be missing)
 *   incomplete  lines are known to be missing
 *   open        the meeting is not finished; the transcript can still grow
 */

const SCHEMA_VERSION = '1.0'
const MAX_SEGMENTS_FOR_NOTES = 2000

function transcriptState(meeting, integrity) {
  if (meeting.status !== 'COMPLETED') return 'open'
  if (!integrity.complete) return 'incomplete'
  return integrity.verified ? 'verified' : 'unverified'
}

export function createMeetingIntelligenceService({ meetingService, generateNotes }) {
  function load(meetingId) {
    const meeting = meetingService.getMeeting(meetingId)
    const integrity = meetingService.getIntegrity(meetingId)
    const segments = meetingService.getTranscript(meetingId)
    const state = transcriptState(meeting, integrity)
    return {
      segments,
      header: {
        schemaVersion: SCHEMA_VERSION,
        meetingId,
        basis: 'saved-canonical-transcript',
        transcript: {
          state,
          meetingStatus: meeting.status,
          segmentCount: segments.length,
          complete: integrity.complete,
          verified: integrity.verified,
          missingSegments: integrity.missingSegments,
          unverifiedSessions: integrity.unverifiedSessions
        }
      }
    }
  }

  return {
    signals(meetingId) {
      const { segments, header } = load(meetingId)
      const found = extractSignals(segments)
      return {
        ...header,
        provisional: header.transcript.state !== 'verified',
        signals: found,
        counts: {
          questions: found.questions.length,
          actionItems: found.actionItems.length,
          decisions: found.decisions.length
        },
        limits:
          'English wording patterns only: implied or unusually phrased items are missed, and an item can match ' +
          'words that were not meant that way. Each item cites the segment it came from.'
      }
    },

    async notes(meetingId, { allowUnverified = false } = {}) {
      if (typeof generateNotes !== 'function') {
        throw new MeetingDomainError('Notes generation is not configured on this server.', {
          statusCode: 503,
          code: 'notes-unavailable'
        })
      }
      const { segments, header } = load(meetingId)
      const state = header.transcript.state
      if (segments.length === 0) {
        throw new MeetingDomainError('The meeting has no saved transcript to summarise.', {
          statusCode: 409,
          code: 'transcript-empty',
          details: header.transcript
        })
      }
      if (state !== 'verified' && !(allowUnverified && state === 'unverified')) {
        throw new MeetingDomainError(
          state === 'open'
            ? 'The meeting is not finished, so its transcript can still change. End it first.'
            : state === 'incomplete'
            ? 'Lines of this transcript are known to be missing. Recover them before summarising.'
            : 'The transcript was never verified as complete. Pass allowUnverified to summarise it anyway.',
          { statusCode: 409, code: 'transcript-not-final', details: header.transcript }
        )
      }
      if (segments.length > MAX_SEGMENTS_FOR_NOTES) {
        throw new MeetingDomainError(
          `The transcript has ${segments.length} lines; summarising more than ${MAX_SEGMENTS_FOR_NOTES} at once is not supported.`,
          { statusCode: 413, code: 'transcript-too-long' }
        )
      }

      let generated
      try {
        generated = await generateNotes({ schemaVersion: SCHEMA_VERSION, segments })
      } catch (err) {
        throw new MeetingDomainError(`The notes provider failed: ${err?.message ?? 'unknown error'}`, {
          statusCode: 502,
          code: 'notes-provider-failed'
        })
      }

      const found = extractSignals(segments)
      const base = { ...header, provisional: state !== 'verified', signals: found }
      if (!generated?.notes) {
        return {
          ...base,
          notes: null,
          problem: 'model-output-unusable',
          detail: generated?.parseError ?? 'The model did not return notes in the expected shape.'
        }
      }
      const grounded = groundNotes(generated.notes, segments)

      // Where the words themselves state it, that finding stands in for the model's reading of the same line.
      const stated = new Set(
        [...found.questions, ...found.actionItems, ...found.decisions].map((item) => `${item.kind}:${item.source.segmentIds[0]}`)
      )
      const items = grounded.items.filter(
        (item) => !['question', 'actionItem', 'decision'].includes(item.kind) || !item.source.segmentIds.some((id) => stated.has(`${item.kind}:${id}`))
      )
      return {
        ...base,
        notes: {
          summary: grounded.summary,
          items,
          rejected: grounded.rejected,
          counts: {
            kept: items.length,
            rejected: grounded.rejected.length,
            uncertain: items.filter((item) => item.status === 'uncertain').length
          }
        }
      }
    }
  }
}
