/**
 * An error of Academic Intelligence that is meant to be shown. `code` is the stable machine name the page acts on, the message is
 * written for a person, and `expose` lets the shared error handler send both even for a 5xx.
 */
export class AcademicError extends Error {
  constructor(statusCode, code, message, { retryAfterSeconds = null, details = null } = {}) {
    super(message)
    this.name = 'AcademicError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
    if (details) this.details = details
    if (retryAfterSeconds !== null) this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
  }
}

/** A trimmed string of 1..max characters (or '' / null when optional). Anything else is a 400 that names the field. */
export function textField(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AcademicError(400, 'invalid-input', `${field} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new AcademicError(400, 'invalid-input', `${field} must be text.`)
  const trimmed = value.replace(/\u0000/g, '').trim()
  if (!trimmed) {
    if (required) throw new AcademicError(400, 'invalid-input', `${field} is required.`)
    return null
  }
  if (trimmed.length > max) throw new AcademicError(400, 'invalid-input', `${field} must be at most ${max} characters.`)
  return trimmed
}

export function oneOf(value, field, allowed, { required = true } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null
  if (!allowed.includes(value)) throw new AcademicError(400, 'invalid-input', `${field} must be one of: ${allowed.join(', ')}.`)
  return value
}
