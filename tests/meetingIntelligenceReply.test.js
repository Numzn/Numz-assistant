import assert from 'node:assert/strict'
import test from 'node:test'
import { describeProvenance, formatIntelligenceReply, noIntelligenceReply, summaryCaution } from '../src/interfaces/commands/meetingIntelligenceReply.js'

const at = (start) => ({ segmentIds: ['seg_1'], start, end: start + 5 })
const item = (kind, text, extra = {}) => ({
  id: `${kind}:${text}`,
  kind,
  text,
  status: 'inferred',
  source: at(65),
  evidence: [{ segmentId: 'seg_1', text }],
  caveats: [],
  ...extra
})

function live(over = {}) {
  return {
    phase: 'live',
    provisional: true,
    transcript: { state: 'open', meetingStatus: 'LIVE', segmentCount: 14, verified: false, complete: true },
    analysis: { status: 'current', lastSuccessAt: '2026-10-10T18:20:11.000Z', pendingSegments: 0, error: null },
    findings: { topics: [], decisions: [], openQuestions: [], questionsAsked: [], actionItems: [], notes: [] },
    final: { status: 'not-started', summary: null, findings: null },
    ...over
  }
}

const verifiedFinal = (over = {}) =>
  live({
    phase: 'final',
    provisional: false,
    transcript: { state: 'verified', meetingStatus: 'COMPLETED', segmentCount: 20, verified: true, complete: true },
    final: {
      status: 'ready',
      summary: { text: 'The team agreed to ship on Friday.', status: 'inferred', unsupportedTerms: [] },
      findings: {
        topics: [item('topic', 'Launch date')],
        decisions: [item('decision', 'Ship on Friday', { status: 'confirmed' })],
        actionItems: [item('actionItem', 'Run testing', { owner: { name: 'Priya', evidence: 'named-in-text' }, due: 'by Thursday', status: 'confirmed' })],
        openQuestions: [item('question', 'Who approves the budget?')],
        questionsAsked: []
      }
    },
    ...over
  })

test('a live reply says it is live and provisional, how many saved lines it rests on, and when it last updated', () => {
  const r = formatIntelligenceReply('decisions', live({ findings: { ...live().findings, decisions: [item('decision', 'Ship on Friday', { status: 'confirmed' })] } }))
  assert.match(r.reply, /Live — provisional/)
  assert.match(r.reply, /14 saved lines/)
  assert.match(r.reply, /Updated \d\d:\d\d:\d\d/)
  assert.match(r.reply, /Ship on Friday — stated in the transcript; at 1:05/)
  assert.equal(r.tone, 'ok')
})

test('a model reading is labelled as one, never as a confirmed finding', () => {
  const r = formatIntelligenceReply('decisions', live({ findings: { ...live().findings, decisions: [item('decision', 'Move to Monday')] } }))
  assert.match(r.reply, /model reading, provisional/)
  assert.doesNotMatch(r.reply, /stated in the transcript/)
})

test('lines the notes have not absorbed yet are reported, not hidden', () => {
  const r = formatIntelligenceReply('notes', live({ analysis: { status: 'behind', lastSuccessAt: '2026-10-10T18:20:11.000Z', pendingSegments: 3, error: null } }))
  assert.match(r.reply, /3 newer lines are not analysed yet/)
  assert.equal(r.tone, 'warn')
})

test('a failing update is not presented as current', () => {
  const r = formatIntelligenceReply(
    'decisions',
    live({
      analysis: {
        status: 'error',
        lastSuccessAt: '2026-10-10T18:20:11.000Z',
        pendingSegments: 4,
        error: { code: 'update-failed', message: 'provider down', at: '2026-10-10T18:25:00.000Z' }
      },
      findings: { ...live().findings, decisions: [item('decision', 'Ship on Friday')] }
    })
  )
  assert.match(r.reply, /failing/)
  assert.match(r.reply, /provider down/)
  assert.match(r.reply, /may be out of date/)
  assert.match(r.reply, /4 newer lines are not analysed/)
  assert.equal(r.tone, 'warn')
  assert.match(r.speech, /may be out of date/)
})

test('an update in progress says so', () => {
  const r = formatIntelligenceReply('notes', live({ analysis: { status: 'updating', lastSuccessAt: null, pendingSegments: 2, error: null } }))
  assert.match(r.reply, /An update is running now/)
  assert.equal(r.tone, 'warn')
})

test('nothing found is said plainly, with the same honesty about how current that is', () => {
  const r = formatIntelligenceReply('decisions', live())
  assert.match(r.reply, /No decisions have been stated yet/)
  assert.match(r.reply, /Live — provisional/)
})

test('owners come only from what was said: unnamed tasks say no owner stated', () => {
  const r = formatIntelligenceReply(
    'owners',
    live({
      findings: {
        ...live().findings,
        actionItems: [
          item('actionItem', 'Run testing', { owner: { name: 'Priya', evidence: 'named-in-text' }, due: 'by Thursday', status: 'confirmed' }),
          item('actionItem', 'Book the room', { owner: { name: null, evidence: null }, due: null })
        ]
      }
    })
  )
  assert.match(r.reply, /\*\*Priya\*\*: Run testing \(by Thursday\)/)
  assert.match(r.reply, /_no owner stated_: Book the room/)
  assert.match(r.reply, /I only report an owner when a speaker named one/)
  assert.match(r.speech, /Priya: Run testing/)
  assert.match(r.speech, /1 task has no owner stated/)
})

test('action items show owner and deadline only when stated', () => {
  const r = formatIntelligenceReply(
    'actions',
    live({ findings: { ...live().findings, actionItems: [item('actionItem', 'Book the room', { owner: { name: null, evidence: null }, due: null })] } })
  )
  assert.match(r.reply, /owner not stated; no deadline stated/)
})

test('open questions: the model\'s list when it has one; otherwise only what was asked, with the limit stated', () => {
  const withModel = formatIntelligenceReply('questions', live({ findings: { ...live().findings, openQuestions: [item('question', 'Who approves the budget?')] } }))
  assert.match(withModel.reply, /Open questions/)
  assert.match(withModel.reply, /Who approves the budget\?/)

  const fallback = formatIntelligenceReply(
    'questions',
    live({
      analysis: { status: 'error', lastSuccessAt: null, pendingSegments: 5, error: { code: 'update-failed', message: 'down', at: null } },
      findings: { ...live().findings, questionsAsked: [item('question', 'When does it ship?', { status: 'confirmed' })] }
    })
  )
  assert.match(fallback.reply, /Questions asked/)
  assert.match(fallback.reply, /cannot tell which of these were answered/)

  const none = formatIntelligenceReply('questions', live())
  assert.match(none.reply, /No unanswered questions were found/)
})

test('final: only a verified, ready record is called final, and it says the transcript was verified', () => {
  const r = formatIntelligenceReply('final', verifiedFinal())
  assert.match(r.reply, /Final — the transcript was verified/)
  assert.match(r.reply, /20 saved lines/)
  assert.match(r.reply, /The team agreed to ship on Friday\./)
  assert.match(r.reply, /Run testing — owner: Priya; due: by Thursday/)
  assert.equal(r.tone, 'ok')
  assert.doesNotMatch(r.reply, /provisional/i)
})

test('a summary that names things the transcript never said is flagged in the reply', () => {
  const r = formatIntelligenceReply(
    'final',
    verifiedFinal({
      final: { ...verifiedFinal().final, summary: { text: 'Marcus approved 40000 dollars.', status: 'uncertain', unsupportedTerms: ['Marcus', '40000'] } }
    })
  )
  assert.match(r.reply, /Check this summary/)
  assert.match(r.reply, /Marcus, 40000/)
})

test('a closed meeting without a verified transcript has no final summary and says why', () => {
  const r = formatIntelligenceReply(
    'final',
    live({
      phase: 'closed',
      transcript: { state: 'unverified', meetingStatus: 'COMPLETED', segmentCount: 9, verified: false, complete: true },
      final: { status: 'withheld', reason: 'transcript-unverified', summary: null, findings: null },
      findings: { ...live().findings, decisions: [item('decision', 'Ship on Friday', { status: 'confirmed' })] }
    })
  )
  assert.match(r.reply, /no final summary/)
  assert.match(r.reply, /could not be verified/)
  assert.match(r.reply, /provisional/)
  assert.equal(r.tone, 'warn')
  assert.doesNotMatch(r.reply, /Final — the transcript was verified/)
})

test('a final that is still being written, or that failed, is not presented as final', () => {
  const running = describeProvenance(live({ phase: 'closing', transcript: { ...live().transcript, meetingStatus: 'COMPLETED', state: 'verified' }, final: { status: 'running' } }))
  assert.match(running.text, /still being written/)
  const failed = describeProvenance(
    live({ phase: 'closed', transcript: { ...live().transcript, meetingStatus: 'COMPLETED', state: 'verified' }, final: { status: 'failed', detail: 'provider down' } })
  )
  assert.match(failed.text, /could not be written/)
  assert.match(failed.text, /provider down/)
  assert.equal(failed.current, false)
})

test('a cancelled or failed meeting is never final', () => {
  const p = describeProvenance(live({ phase: 'ended', transcript: { ...live().transcript, meetingStatus: 'CANCELLED', segmentCount: 3 } }))
  assert.match(p.text, /did not complete/)
})

test('long lists are cut, with the count of what was left out', () => {
  const many = Array.from({ length: 11 }, (_, i) => item('decision', `Decision number ${i + 1}`))
  const r = formatIntelligenceReply('decisions', live({ findings: { ...live().findings, decisions: many } }))
  assert.match(r.reply, /Decision number 8/)
  assert.doesNotMatch(r.reply, /Decision number 9/)
  assert.match(r.reply, /and 3 more in the meeting panel/)
  assert.match(r.speech, /and 8 more/)
})

test('the spoken form is plain: no Markdown, short', () => {
  const r = formatIntelligenceReply('final', verifiedFinal())
  assert.doesNotMatch(r.speech, /[*_#`]|^- /m)
  assert.ok(r.speech.length < r.reply.length + 200)
})

test('no meeting, nothing yet, and an error each have their own plain reply', () => {
  assert.match(noIntelligenceReply().reply, /no meeting to ask about/)
  assert.match(noIntelligenceReply({ meetingOpen: true }).reply, /nothing to report yet/)
  const failed = noIntelligenceReply({ error: { message: 'Could not reach the server for the meeting notes.' } })
  assert.match(failed.reply, /Could not reach the server/)
  assert.equal(failed.tone, 'error')
})

test('the summary caution is one rule, used by chat and the panel', () => {
  assert.equal(summaryCaution(null), null)
  assert.equal(summaryCaution({ text: 'ok', status: 'inferred', unsupportedTerms: [] }), null)
  assert.match(summaryCaution({ text: 'x', status: 'uncertain', unsupportedTerms: ['Marcus', '40000'] }), /mentions Marcus, 40000/)
  assert.match(summaryCaution({ text: 'x', status: 'uncertain', unsupportedTerms: [] }), /weakly supported/)
})
