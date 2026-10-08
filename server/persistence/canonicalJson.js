import { createHash } from 'node:crypto'

/** Recursively sorts object keys and drops undefined values so equal content always serializes identically. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

/** SHA-256 over the canonical JSON form. Used to tell an exact duplicate from an ID collision. */
export function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}
