import { MeetingDomainError } from './meetingDomain.js'

/** Upper bounds that keep a single bad or hostile segment from bloating storage. */
export const MAX_SEGMENT_BYTES = 64 * 1024
export const MAX_TEXT_LENGTH = 8000
export const MAX_SESSION_SECONDS = 7 * 24 * 3600

const SEGMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

function invalid(message) {
  return new MeetingDomainError(message, { statusCode: 400, code: 'invalid-segment' })
}

/**
 * Validates one FINAL canonical segment as produced by the speech transport.
 * Timestamps are session-relative here; the service maps them onto the meeting timeline.
 * Throws MeetingDomainError (400) and never normalizes silently.
 */
export function validateFinalSegment(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
    throw invalid('segment must be an object')
  }
  if (typeof segment.id !== 'string' || !SEGMENT_ID_RE.test(segment.id)) {
    throw invalid('segment.id must be 1-128 characters: letters, digits, _ . : -')
  }
  const label = `segment ${segment.id}`
  if (Buffer.byteLength(JSON.stringify(segment), 'utf8') > MAX_SEGMENT_BYTES) {
    throw invalid(`${label} exceeds ${MAX_SEGMENT_BYTES} bytes`)
  }
  const { start, end } = segment
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw invalid(`${label}: start and end must be finite numbers`)
  }
  if (start < 0 || end < start || end > MAX_SESSION_SECONDS) {
    throw invalid(`${label}: timestamps must satisfy 0 <= start <= end <= ${MAX_SESSION_SECONDS}`)
  }
  if (typeof segment.text !== 'string' || !segment.text.trim()) {
    throw invalid(`${label}: text must be a non-empty string`)
  }
  if (segment.text.length > MAX_TEXT_LENGTH) {
    throw invalid(`${label}: text exceeds ${MAX_TEXT_LENGTH} characters`)
  }
  if (segment.speaker !== undefined && segment.speaker !== null) {
    if (typeof segment.speaker !== 'string' || segment.speaker.length > 64) {
      throw invalid(`${label}: speaker must be null or a string of at most 64 characters`)
    }
  }
  if (typeof segment.uncertain !== 'boolean') {
    throw invalid(`${label}: uncertain must be a boolean`)
  }
  if (segment.words !== undefined && !Array.isArray(segment.words)) {
    throw invalid(`${label}: words must be an array`)
  }
  if (segment.confidence !== undefined && segment.confidence !== null && !Number.isFinite(segment.confidence)) {
    throw invalid(`${label}: confidence must be a finite number or null`)
  }
  if (segment.language !== undefined && segment.language !== null && typeof segment.language !== 'string') {
    throw invalid(`${label}: language must be a string or null`)
  }
  return segment
}
