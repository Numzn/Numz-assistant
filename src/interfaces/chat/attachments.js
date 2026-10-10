/**
 * Text-file attachments.
 *
 * The assistant backend takes plain text (the model behind it has no file or image input), so an attachment is a
 * text file whose contents are read in the browser and sent as part of the message. There is no upload and
 * nothing is stored apart from the conversation itself. Binary files, images and PDFs are refused with a clear
 * reason rather than sent as garbage.
 *
 * A session re-sends its whole history to the model every turn, so an attached file is re-sent each turn too;
 * the limits below keep that bounded (about 15,000 tokens per message at most).
 */

export const MAX_FILES = 3
export const MAX_TOTAL_CHARS = 60_000
export const MAX_FILE_BYTES = 240_000 // reading limit; the character limit above is what is enforced

/** What the file picker offers. The content is checked either way: the extension only narrows the list. */
export const ACCEPT =
  '.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.xml,.yml,.yaml,.toml,.ini,.html,.htm,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sh,.sql,.tex,.rtf,text/*'

export class AttachmentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
  }
}

const HEADER = /\[Attached file: ([^\]\n]+)\]/

function cleanName(name) {
  return (
    String(name ?? 'file')
      .replace(/[\]\n\r]/g, '_')
      .trim()
      .slice(0, 100) || 'file'
  )
}

export function formatSize(characters) {
  return characters < 1000 ? `${characters} chars` : `${(characters / 1000).toFixed(characters < 10_000 ? 1 : 0)}k chars`
}

/** Reads a File as UTF-8 text, or throws an AttachmentError saying why it cannot be attached. */
export async function readTextFile(file) {
  const name = cleanName(file?.name)
  if (!file || typeof file.arrayBuffer !== 'function') throw new AttachmentError('read-failed', `${name} could not be read.`)
  if (file.size === 0) throw new AttachmentError('empty', `${name} is empty.`)
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError('too-large', `${name} is too large (${Math.round(file.size / 1000)} KB). The limit is about ${MAX_TOTAL_CHARS / 1000} KB of text per message.`)
  }
  if (/^(image|audio|video)\//.test(file.type ?? '') || file.type === 'application/pdf') {
    throw new AttachmentError('unsupported', `${name} is not a text file. Only text can be attached: the assistant cannot read images, audio or PDFs.`)
  }

  let text
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AttachmentError('binary', `${name} is not a text file (it is not valid UTF-8 text), so it cannot be attached.`)
  }
  if (text.includes('\u0000')) throw new AttachmentError('binary', `${name} looks like a binary file, so it cannot be attached.`)
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!text.trim()) throw new AttachmentError('empty', `${name} has no text in it.`)
  return { name, size: text.length, text }
}

/** Checks that `next` can join `existing`: at most MAX_FILES, at most MAX_TOTAL_CHARS of text between them. */
export function checkRoom(existing, next) {
  if (existing.length >= MAX_FILES) throw new AttachmentError('too-many', `At most ${MAX_FILES} files can be attached to one message.`)
  const total = existing.reduce((sum, file) => sum + file.size, 0) + next.size
  if (total > MAX_TOTAL_CHARS) {
    throw new AttachmentError(
      'too-large',
      `${next.name} would make the attachments longer than ${MAX_TOTAL_CHARS.toLocaleString('en-US')} characters (the limit for one message). Attach a smaller file or a part of it.`
    )
  }
}

/** The text sent to the assistant: what the user typed, then each file under a header, in a code fence. */
export function composeMessage(text, attachments = []) {
  const typed = String(text ?? '').trim()
  if (!attachments.length) return typed
  const parts = typed ? [typed] : []
  for (const file of attachments) {
    const longestRun = Math.max(0, ...(file.text.match(/`+/g) ?? []).map((run) => run.length))
    const fence = '`'.repeat(Math.max(3, longestRun + 1)) // longer than any run inside, so the file cannot end its own fence
    parts.push(`[Attached file: ${cleanName(file.name)}]\n${fence}\n${file.text.replace(/\n+$/, '')}\n${fence}`)
  }
  return parts.join('\n\n')
}

/**
 * The reverse of composeMessage, for showing a stored message without the file contents:
 * { text, attachments: [{ name, size }] }. A message with no attachment header is returned unchanged.
 */
export function splitMessage(content) {
  const source = String(content ?? '')
  const attachments = []
  const pattern = new RegExp(`(?:\\n\\n)?${HEADER.source}\\n(\`{3,})\\n([\\s\\S]*?)\\n\\2(?=\\n\\n|\\n?$)`, 'g')
  const text = source
    .replace(pattern, (_match, name, _fence, body) => {
      attachments.push({ name, size: body.length })
      return ''
    })
    .trim()
  return { text, attachments }
}
