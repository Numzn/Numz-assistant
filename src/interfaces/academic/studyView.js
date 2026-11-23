/**
 * The Study panel: a study session (declare its kind, optionally let NUMZ AI read the screen, see what it found, ask, give feedback),
 * the person's course materials, and the Memory Centre (what NUMZ AI remembers, to correct or delete). It draws the controller's state
 * and calls its methods; the materials and memory tabs talk to the academic API directly because they hold no state of their own.
 *
 * Everything is built with createElement and textContent: nothing from the server, the screen or a document is ever parsed as HTML.
 * A persistent indicator in the panel header says whether a session is open and whether the screen is being read; the desktop app also
 * puts it in its window title.
 */

import { renderMarkdown } from '../chat/markdownView.js'

const SESSION_TYPES = [
  ['study', 'Study', 'Learning new material. NUMZ AI can read your screen (if you allow it) and give you the correct answers; ask it to explain whenever you want.'],
  ['practice', 'Practice', 'Practice questions and past papers where help is allowed. Same help: the correct answers, and the explanation whenever you ask for it.'],
  ['restricted', 'Restricted assessment', 'An assessment that does not allow help. NUMZ AI will not read your screen or answer questions: it can only explain concepts in general terms.']
]
const SOURCE_TYPES = [['lecture_notes', 'Lecture notes'], ['course_outline', 'Course outline'], ['study_guide', 'Study guide'], ['textbook', 'Textbook'], ['notes', 'My notes'], ['research', 'Research'], ['other', 'Other']]
const EXCLUSIONS_KEY = 'numz.study.exclusions'

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) el.setAttribute(key, '')
    else el.setAttribute(key, String(value))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(typeof child === 'string' ? doc.createTextNode(child) : child)
  return el
}

function loadExclusions() {
  try {
    return String(globalThis.localStorage?.getItem(EXCLUSIONS_KEY) ?? '')
  } catch {
    return ''
  }
}
function saveExclusions(text) {
  try {
    globalThis.localStorage?.setItem(EXCLUSIONS_KEY, text)
  } catch {
    /* a convenience only: it works without storage */
  }
}
export const parseExclusions = (text) => String(text ?? '').split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 30)
/** What the person asked never to be read, as the desktop app wants it (the same words match an application's name or a window's title). */
export function storedExclusions() {
  const words = parseExclusions(loadExclusions())
  return { apps: words, titles: words }
}

export function createStudyView({ controller, api, doc = document, onOpen = () => {}, onShowInChat = null } = {}) {
  const $ = (id) => doc.getElementById(id)
  const button = $('studyButton')
  const panel = $('studyPanel')
  if (!button || !panel) return null
  const body = $('studyBody')
  const indicator = $('studyIndicator')
  const tabs = [...panel.querySelectorAll('[data-study-tab]')]
  let tab = 'session'
  let formState = { type: 'study', courseId: '', topic: '', capture: false, autoAnswer: true, research: false, exclusions: loadExclusions() }
  // limits: what the server allows (it says so: GET /limits); these are its defaults until it answers.
  let materials = { courseId: '', documents: [], lectures: [], message: '', busy: false, uploading: false, limits: { maxDocumentBytes: 100 * 1024 * 1024, maxBatchFiles: 50 } }
  let pollTimer = null
  let memory = { data: null, message: '', busy: false, failed: false }
  let askText = ''
  let correcting = false

  // ---- the session tab ---------------------------------------------------------------------------------------------

  function renderStart(state) {
    const watchOk = state.watch.available
    const restricted = formState.type === 'restricted'
    const field = (label, control, hint) => h(doc, 'label', { class: 'study-field' }, h(doc, 'span', { text: label }), control, hint ? h(doc, 'small', { text: hint }) : null)
    return h(
      doc,
      'form',
      {
        class: 'study-start',
        onsubmit: (e) => {
          e.preventDefault()
          saveExclusions(formState.exclusions)
          controller.start({ type: formState.type, courseId: formState.courseId || undefined, topic: formState.topic || undefined, captureEnabled: formState.capture && !restricted, autoAnswer: formState.autoAnswer && formState.capture && !restricted, useResearch: formState.research && !restricted })
        }
      },
      h(doc, 'p', { class: 'study-lead', text: 'Start a study session and say what kind it is. NUMZ AI only does what that kind allows.' }),
      h(
        doc,
        'fieldset',
        { class: 'study-types' },
        h(doc, 'legend', { text: 'This session is' }),
        SESSION_TYPES.map(([value, title, text]) =>
          h(doc, 'label', { class: 'study-type' }, h(doc, 'input', { type: 'radio', name: 'studyType', value, checked: formState.type === value, onchange: () => { formState.type = value; if (value === 'restricted') Object.assign(formState, { capture: false, research: false }); render(true) } }), h(doc, 'span', { class: 'study-type-title', text: title }), h(doc, 'small', { text }))
        )
      ),
      field('Course', h(doc, 'select', { onchange: (e) => (formState.courseId = e.target.value) }, h(doc, 'option', { value: '', text: state.courses.length ? 'No course chosen' : 'No courses yet (add one in Materials)' }), state.courses.map((c) => h(doc, 'option', { value: c.id, selected: c.id === formState.courseId, text: c.code ? `${c.code} ${c.title}` : c.title })))),
      field('Topic (optional)', h(doc, 'input', { type: 'text', maxlength: 120, value: formState.topic, oninput: (e) => (formState.topic = e.target.value) })),
      h(doc, 'label', { class: 'study-check' }, h(doc, 'input', { type: 'checkbox', checked: formState.capture && !restricted, disabled: restricted || !watchOk, onchange: (e) => { formState.capture = e.target.checked; render(true) } }), h(doc, 'span', { text: 'Read my screen while I study' })),
      h(doc, 'small', { class: 'study-note', text: restricted ? 'Not available in a restricted session.' : watchOk ? 'Looks at the screen every few seconds, and only reads it when it changes. Never while a password manager, a sign-in screen or a window you list below is open.' : state.watch.note || 'Not available here.' }),
      formState.capture && !restricted && watchOk
        ? [
            h(doc, 'label', { class: 'study-check' }, h(doc, 'input', { type: 'checkbox', checked: formState.autoAnswer, onchange: (e) => (formState.autoAnswer = e.target.checked) }), h(doc, 'span', { text: 'Answer the questions it finds, without me pressing anything' })),
            field('Never read the screen while a window with these words is open', h(doc, 'input', { type: 'text', value: formState.exclusions, placeholder: 'for example: slack, bank, payroll', oninput: (e) => (formState.exclusions = e.target.value) }), 'Password managers and sign-in screens are always left out.')
          ]
        : null,
      h(doc, 'label', { class: 'study-check' }, h(doc, 'input', { type: 'checkbox', checked: formState.research && !restricted, disabled: restricted, onchange: (e) => (formState.research = e.target.checked) }), h(doc, 'span', { text: 'Also look up scholarly sources (titles and abstracts, checked against Crossref)' })),
      h(doc, 'button', { type: 'submit', class: 'study-primary', disabled: state.phase === 'starting', text: state.phase === 'starting' ? 'Starting…' : 'Start session' })
    )
  }

  function indicatorText(state) {
    if (!state.session) return ['No session', 'off']
    const kind = SESSION_TYPES.find(([v]) => v === state.session.sessionType)?.[1] ?? state.session.sessionType
    const reading = state.watch.status === 'watching' ? (state.watch.excludedNow ? 'screen reading held: something excluded is open' : 'screen reading ON') : state.watch.status === 'paused' ? 'paused' : 'screen reading off'
    return [`${kind}${state.phase === 'paused' ? ' (paused)' : ''} · ${reading}`, state.watch.status === 'watching' ? 'reading' : state.phase === 'paused' ? 'paused' : 'on']
  }

  /** An answer, drawn as the Markdown it is (the conversation's own renderer: nothing is parsed as HTML). */
  function answerBox(markdown) {
    const box = h(doc, 'div', { class: 'study-answer' })
    renderMarkdown(box, markdown, doc)
    return box
  }

  function renderQuestion(state, q) {
    const answer = q.answer
    return h(
      doc,
      'li',
      { class: 'study-q', 'data-state': q.state },
      h(doc, 'div', { class: 'study-q-text', text: q.text }),
      q.options?.length ? h(doc, 'ul', { class: 'study-q-options' }, q.options.map((o) => h(doc, 'li', { text: `${o.label}) ${o.text}` }))) : null,
      h(doc, 'div', { class: 'study-q-meta' }, h(doc, 'span', { class: 'study-chip', text: (q.task ?? 'explain').replace('_', ' ') }), q.partial ? h(doc, 'span', { class: 'study-chip', 'data-tone': 'warn', text: 'cut off by the screen' }) : null, q.marks ? h(doc, 'span', { class: 'study-chip', text: `${q.marks} marks` }) : null),
      q.state === 'confirm'
        ? h(doc, 'div', { class: 'study-warn' }, h(doc, 'p', { text: q.message }), h(doc, 'button', { type: 'button', text: 'This is practice: carry on', onclick: () => controller.answerQuestion(q.id, { confirmPractice: true }) }), h(doc, 'button', { type: 'button', text: 'End this session', onclick: () => controller.stop() }))
        : null,
      q.state === 'needs-course'
        ? h(doc, 'div', { class: 'study-warn' }, h(doc, 'p', { text: q.message }), (q.candidates ?? []).map((c) => h(doc, 'button', { type: 'button', text: c.title, onclick: () => controller.answerQuestion(q.id, { courseId: c.courseId }) })))
        : null,
      q.state === 'failed' ? h(doc, 'p', { class: 'study-error', text: q.message }) : null,
      q.state === 'new' || q.state === 'failed' ? h(doc, 'button', { type: 'button', class: 'study-primary', disabled: state.phase === 'paused', text: q.partial ? 'Answer what is visible' : 'Answer', onclick: () => controller.answerQuestion(q.id) }) : null,
      q.state === 'answering' ? h(doc, 'p', { class: 'study-working', text: 'Working on it…' }) : null,
      // The answer itself, right here (it is also in the conversation): the correct answer is what is wanted, so it is not behind a click.
      answer?.markdown ? answerBox(answer.markdown) : null,
      answer
        ? h(doc, 'p', { class: 'study-answered', text: `Answered in the conversation (${answer.grounding === 'course' ? 'from your course materials' : answer.grounding === 'research' ? 'from research' : answer.grounding === 'both' ? 'from your materials and research' : 'from general knowledge'}).` })
        : null,
      // The explanation is given when it is asked for, never before.
      answer && answer.approach === 'answer'
        ? h(doc, 'button', { type: 'button', class: 'study-link', disabled: state.phase === 'paused', text: 'Explain', onclick: () => controller.answerQuestion(q.id, { style: 'explain' }) })
        : null,
      // On a narrow window this panel covers the conversation the answer was written in: this takes the person to it.
      answer?.ref && onShowInChat
        ? h(doc, 'button', {
            type: 'button',
            class: 'study-link',
            text: 'Show in chat',
            onclick: (e) => {
              if (onShowInChat(answer.ref) !== false) return
              e.currentTarget.textContent = 'No longer in this conversation'
              e.currentTarget.disabled = true
            }
          })
        : null
    )
  }

  const STATUS_TEXT = { new: 'new', seen: 'seen before', grew: 'more of it now', continued: 'continued' }
  /** Everything the session has seen, once each, whatever it is: the organised record of the screens read so far. */
  function renderContent(state) {
    if (!state.content.length) return null
    const items = [...state.content].reverse()
    return h(
      doc,
      'details',
      { class: 'study-content' },
      h(doc, 'summary', { text: `Content seen in this session (${state.content.length})` }),
      h(doc, 'ul', { class: 'study-segments' }, items.map((c) => {
        const related = c.continuesFrom ? state.content.find((x) => x.id === c.continuesFrom) : null
        return h(doc, 'li', { class: 'study-segment', 'data-status': c.status },
          h(doc, 'div', { class: 'study-q-meta' },
            h(doc, 'span', { class: 'study-chip', text: c.kind }),
            c.title ? h(doc, 'span', { class: 'study-chip', text: c.title }) : null,
            h(doc, 'span', { class: 'study-chip', 'data-tone': c.status === 'seen' ? '' : 'ok', text: STATUS_TEXT[c.status] ?? c.status }),
            c.partial ? h(doc, 'span', { class: 'study-chip', 'data-tone': 'warn', text: 'cut off' }) : null,
            c.seenCount > 1 ? h(doc, 'span', { class: 'study-chip', text: `seen ${c.seenCount} times` }) : null),
          h(doc, 'p', { class: 'study-segment-text', text: c.text.length > 180 ? `${c.text.slice(0, 180)}…` : c.text }),
          related ? h(doc, 'small', { class: 'study-note', text: `Continues: ${related.title || related.text.slice(0, 40)}…` }) : null,
          c.kind !== 'question' && state.session?.sessionType !== 'restricted' ? h(doc, 'button', { type: 'button', disabled: state.phase === 'paused' || state.busy, text: 'Explain this', onclick: () => controller.explainSegment(c.id) }) : null)
      }))
    )
  }

  function renderActive(state) {
    const restricted = state.session.sessionType === 'restricted'
    const last = state.lastAnswer
    return h(
      doc,
      'div',
      { class: 'study-active' },
      h(doc, 'div', { class: 'study-bar' },
        state.phase === 'paused' ? h(doc, 'button', { type: 'button', text: 'Resume', onclick: () => controller.resume() }) : h(doc, 'button', { type: 'button', text: 'Pause', onclick: () => controller.pause() }),
        !restricted && state.watch.available && state.watch.status === 'off' ? h(doc, 'button', { type: 'button', text: 'Turn screen reading on', onclick: () => controller.resumeWatching() }) : null,
        h(doc, 'button', { type: 'button', 'data-danger': 'true', text: 'End session', onclick: () => controller.stop() })
      ),
      state.watch.status !== 'off' ? h(doc, 'p', { id: 'studyWatchNote', class: 'study-note', 'aria-live': 'off', text: watchNote(state) }) : null,
      restricted ? h(doc, 'p', { class: 'study-warn', text: 'Restricted assessment: NUMZ AI is not reading your screen and will not answer questions. Name a concept below to have it explained in general terms.' }) : null,
      state.questions.length ? h(doc, 'ul', { class: 'study-questions' }, state.questions.map((q) => renderQuestion(state, q))) : !restricted ? h(doc, 'p', { class: 'study-empty', text: state.watch.status === 'watching' ? 'Waiting for something on your screen to read…' : 'Questions NUMZ AI finds on your screen appear here. You can also type one below.' }) : null,
      renderContent(state),
      h(
        doc,
        'form',
        { class: 'study-ask', onsubmit: async (e) => { e.preventDefault(); const text = askText; askText = ''; render(true); await (restricted ? controller.explainConcept(text) : controller.ask(text)) } },
        h(doc, 'label', { class: 'sr-only', for: 'studyAskInput', text: restricted ? 'Name a concept' : 'Ask a question' }),
        h(doc, 'input', { id: 'studyAskInput', type: 'text', maxlength: restricted ? 120 : 2000, placeholder: restricted ? 'Name a concept, for example “second normal form”' : 'Type a question', value: askText, disabled: state.phase === 'paused' || state.busy, oninput: (e) => (askText = e.target.value) }),
        h(doc, 'button', { type: 'submit', disabled: state.phase === 'paused' || state.busy, text: restricted ? 'Explain concept' : 'Ask' })
      ),
      last
        ? h(doc, 'div', { class: 'study-feedback' },
            h(doc, 'span', { text: 'That answer:' }),
            h(doc, 'button', { type: 'button', text: 'Helped', onclick: () => controller.feedback('helpful') }),
            h(doc, 'button', { type: 'button', text: 'Didn’t help', onclick: () => controller.feedback('not_helpful') }),
            h(doc, 'button', { type: 'button', text: 'Simpler', onclick: () => controller.feedback('simpler') }),
            h(doc, 'button', { type: 'button', text: 'Deeper', onclick: () => controller.feedback('deeper') }),
            h(doc, 'button', { type: 'button', text: 'Something is wrong', onclick: () => { correcting = !correcting; render(true) } }),
            h(doc, 'button', { type: 'button', text: 'Keep as a note', onclick: () => controller.feedback('save_concept') }),
            correcting
              ? h(doc, 'form', { class: 'study-ask', onsubmit: (e) => { e.preventDefault(); const note = e.target.elements.note.value; correcting = false; render(true); controller.feedback('correction', { note }) } }, h(doc, 'input', { name: 'note', type: 'text', maxlength: 400, placeholder: 'What is wrong?' }), h(doc, 'button', { type: 'submit', text: 'Tell NUMZ AI' }))
              : null
          )
        : null
    )
  }

  function renderSession(state) {
    return state.session ? renderActive(state) : renderStart(state)
  }

  // ---- the materials tab -----------------------------------------------------------------------------------------------------

  async function loadMaterials(state) {
    if (!api) return
    materials.busy = true
    try {
      if (materials.courseId) materials.documents = (await api.documents.list(materials.courseId)).documents ?? []
      materials.lectures = (await api.documents.lectures()).lectures ?? []
      const limits = await api.documents.limits?.().catch(() => null)
      if (limits?.maxDocumentBytes > 0 && limits?.maxBatchFiles > 0) materials.limits = limits
    } catch (err) {
      materials.message = err.message
    }
    materials.busy = false
    render(true)
    watchProcessing()
  }

  // A large document is cut and indexed in the background: while any is, the list is looked at again every couple of seconds (and not once the
  // person has gone to another tab or closed the panel).
  function watchProcessing() {
    clearTimeout(pollTimer)
    pollTimer = null
    if (tab !== 'materials' || panel.hidden || !materials.documents.some((d) => d.status === 'processing')) return
    pollTimer = setTimeout(() => loadMaterials(controller.getState()), 2000)
  }

  const sizeWords = (bytes) => (bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
  const describeDocument = (d) => {
    const base = `${d.title} · ${d.sourceType.replace('_', ' ')} · v${d.version}`
    if (d.status === 'processing') return `${base} · processing… ${d.chunkCount} parts so far`
    if (d.status === 'failed') return `${base} · failed: ${d.error || 'it could not be processed'}`
    return `${base} · ${d.chunkCount} parts`
  }

  async function mutate(work, done) {
    try {
      await work()
      materials.message = done
      await controller.refreshCourses()
    } catch (err) {
      materials.message = err.message
    }
    await loadMaterials(controller.getState())
  }

  /** One or several files, one after the other (the server cuts a large one in the background); each is accounted for, with the reason when it was not added. */
  async function upload(files, courseId, type) {
    const chosen = [...(files ?? [])]
    if (!chosen.length || materials.uploading) return
    const { maxDocumentBytes, maxBatchFiles } = materials.limits
    const batch = chosen.slice(0, maxBatchFiles)
    const problems = []
    let added = 0
    materials.uploading = true
    for (const [index, file] of batch.entries()) {
      materials.message = batch.length > 1 ? `Adding ${index + 1} of ${batch.length}: ${file.name}…` : `Adding ${file.name}…`
      render(true)
      if (/^(image|audio|video)\//.test(file.type) || file.type === 'application/pdf' || /\.(pdf|png|jpe?g|gif|webp|docx?|pptx?)$/i.test(file.name)) {
        problems.push(`${file.name}: only text and markdown files can be added (not PDFs, images or Office files)`)
        continue
      }
      if (file.size > maxDocumentBytes) {
        problems.push(`${file.name}: larger than ${sizeWords(maxDocumentBytes)}, split it into parts`)
        continue
      }
      try {
        const markdown = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown'
        await api.documents.upload(courseId, { title: file.name.replace(/\.[^.]+$/, ''), type, file, markdown })
        added += 1
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`)
      }
    }
    materials.uploading = false
    const parts = []
    if (batch.length === 1 && !problems.length) parts.push(`Added ${batch[0].name}.`)
    else parts.push(added ? `Added ${added} of ${batch.length} file${batch.length === 1 ? '' : 's'}.` : 'Nothing was added.')
    if (problems.length) parts.push(`Not added: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}.`)
    if (chosen.length > batch.length) parts.push(`${chosen.length - batch.length} more were left out: ${maxBatchFiles} files at a time.`)
    materials.message = parts.join(' ')
    await controller.refreshCourses().catch(() => {})
    await loadMaterials(controller.getState())
  }

  function renderMaterials(state) {
    const courseId = materials.courseId || state.courses[0]?.id || ''
    if (courseId !== materials.courseId) {
      materials.courseId = courseId
      loadMaterials(state)
    }
    let type = 'lecture_notes'
    return h(
      doc,
      'div',
      { class: 'study-materials' },
      h(doc, 'p', { class: 'study-lead', text: 'Give NUMZ AI your own course notes as text or markdown. It finds the relevant parts when you ask, and shows which one it used. Each course is kept apart.' }),
      h(doc, 'form', { class: 'study-ask', onsubmit: (e) => { e.preventDefault(); const input = e.target.elements.title; const title = input.value; input.value = ''; mutate(() => api.courses.create({ title }), `Added the course ${title}.`) } }, h(doc, 'input', { name: 'title', type: 'text', maxlength: 160, placeholder: 'New course, for example Database Systems', required: true }), h(doc, 'button', { type: 'submit', text: 'Add course' })),
      state.courses.length
        ? [
            h(doc, 'label', { class: 'study-field' }, h(doc, 'span', { text: 'Course' }), h(doc, 'select', { onchange: (e) => { materials.courseId = e.target.value; loadMaterials(state) } }, state.courses.map((c) => h(doc, 'option', { value: c.id, selected: c.id === courseId, text: c.code ? `${c.code} ${c.title}` : c.title })))),
            h(doc, 'div', { class: 'study-upload' },
              h(doc, 'select', { 'aria-label': 'What kind of document', onchange: (e) => (type = e.target.value) }, SOURCE_TYPES.map(([v, t]) => h(doc, 'option', { value: v, text: t }))),
              h(doc, 'input', { type: 'file', multiple: true, accept: '.md,.markdown,.txt,text/plain,text/markdown', 'aria-label': 'Add text or markdown files', onchange: (e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; upload(files, courseId, type) } })
            ),
            h(doc, 'p', { class: 'study-note', text: `Up to ${sizeWords(materials.limits.maxDocumentBytes)} each and ${materials.limits.maxBatchFiles} files at a time. A large file is prepared in the background.` }),
            materials.lectures.length
              ? h(doc, 'div', { class: 'study-upload' }, h(doc, 'select', { id: 'studyLecture', 'aria-label': 'A finished lecture' }, materials.lectures.map((l) => h(doc, 'option', { value: l.meetingId, text: `${l.title ?? 'Lecture'} · ${String(l.createdAt).slice(0, 10)}` }))), h(doc, 'button', { type: 'button', text: 'Add this lecture to the course', onclick: () => mutate(() => api.documents.fromMeeting(courseId, $('studyLecture').value), 'Lecture added.') }))
              : null,
            h(doc, 'ul', { class: 'study-docs' }, materials.documents.map((d) => h(doc, 'li', { 'data-status': d.status }, h(doc, 'span', { text: describeDocument(d) }), d.status === 'failed' ? h(doc, 'button', { type: 'button', 'aria-label': `Retry ${d.title}`, text: 'Retry', onclick: () => mutate(() => api.documents.retry(d.id), `Processing ${d.title} again.`) }) : null, h(doc, 'button', { type: 'button', 'aria-label': `Delete ${d.title}`, text: 'Delete', onclick: () => mutate(() => api.documents.remove(d.id), `Deleted ${d.title}.`) })))),
            !materials.documents.length ? h(doc, 'p', { class: 'study-empty', text: 'No documents in this course yet.' }) : null,
            h(doc, 'button', { type: 'button', 'data-danger': 'true', text: 'Delete this course and everything about it', onclick: () => { if (globalThis.confirm?.('Delete this course, its documents and what NUMZ AI learned about it?') !== false) { materials.courseId = ''; mutate(() => api.courses.remove(courseId), 'Course deleted.') } } })
          ]
        : h(doc, 'p', { class: 'study-empty', text: 'Add a course to start adding materials.' }),
      materials.message ? h(doc, 'p', { class: 'study-note', role: 'status', text: materials.message }) : null
    )
  }

  // ---- the memory tab -----------------------------------------------------------------------------------------------------------

  async function loadMemory() {
    if (!api) return
    memory.busy = true
    memory.failed = false
    try {
      memory.data = await api.memory.inspect()
    } catch (err) {
      memory.message = err.message
      memory.failed = true
    }
    memory.busy = false
    render(true)
  }

  async function memoryAction(work, done) {
    try {
      await work()
      memory.message = done
    } catch (err) {
      memory.message = err.message
    }
    await loadMemory()
  }

  function renderMemory() {
    if (!memory.data && !memory.busy && !memory.failed) loadMemory()
    const d = memory.data
    if (!d) return h(doc, 'p', { class: 'study-empty', text: memory.message || 'Loading…' })
    const L = d.lanes
    const profile = L.profile.learningProfile
    const section = (title, ...kids) => h(doc, 'section', { class: 'study-lane' }, h(doc, 'h3', { text: title }), ...kids)
    const select = (label, key, options) => h(doc, 'label', { class: 'study-field' }, h(doc, 'span', { text: label }), h(doc, 'select', { onchange: (e) => memoryAction(() => api.profile.update({ learningProfile: { [key]: e.target.value } }), 'Saved.') }, options.map(([v, t]) => h(doc, 'option', { value: v, selected: profile[key] === v, text: t }))))
    return h(
      doc,
      'div',
      { class: 'study-memory' },
      h(doc, 'p', { class: 'study-lead', text: 'This is everything NUMZ AI keeps about your studying. It is private to you. Change or delete any of it.' }),
      section('How I like things explained', select('Writing style', 'writingStyle', [['natural_student_academic', 'Natural, straightforward, student level'], ['concise', 'Short and plain'], ['detailed', 'Thorough']]), select('Level', 'explanationLevel', [['simple', 'Simple'], ['clear_and_accessible', 'Clear and accessible'], ['advanced', 'Advanced']]), select('Approach', 'learningApproach', [['step_by_step', 'Step by step'], ['example_first', 'Example first'], ['concept_first', 'Concept first'], ['visual', 'Describe a picture']]),
        h(doc, 'label', { class: 'study-check' }, h(doc, 'input', { type: 'checkbox', checked: d.adaptiveLearning, onchange: (e) => memoryAction(() => api.profile.update({ adaptiveLearning: e.target.checked }), e.target.checked ? 'NUMZ AI will learn from your feedback.' : 'NUMZ AI will not remember or use feedback.') }), h(doc, 'span', { text: 'Learn from my feedback (what helped, what did not)' }))),
      section('Courses', L.academic.courses.length ? h(doc, 'ul', {}, L.academic.courses.map((c) => h(doc, 'li', { text: c.code ? `${c.code} ${c.title}` : c.title }))) : h(doc, 'p', { class: 'study-empty', text: 'None yet.' })),
      section('Course materials', h(doc, 'p', { text: `${L.knowledge.documents.length} document${L.knowledge.documents.length === 1 ? '' : 's'}.` }), L.knowledge.documents.length ? h(doc, 'button', { type: 'button', 'data-danger': 'true', text: 'Delete all my course materials', onclick: () => memoryAction(() => api.memory.removeLane('knowledge'), 'Course materials deleted.') }) : null),
      section('Recent conversations', h(doc, 'p', { class: 'study-note', text: 'Conversations are kept and deleted from the conversation list, as before.' }), h(doc, 'ul', {}, L.conversation.recent.map((c) => h(doc, 'li', { text: c.title ?? 'Untitled' })))),
      section('What I have learned about how you learn',
        L.experience.items.length
          ? h(doc, 'ul', { class: 'study-docs' }, L.experience.items.map((e) => h(doc, 'li', {}, h(doc, 'span', { text: `${e.topic} · ${e.kind.replace('_', ' ')}${e.difficulty ? ` · ${e.difficulty.replace('_', ' ')}` : ''} · ${Math.round(e.confidence * 100)}% sure${e.status === 'needs_reassessment' ? ' · may be out of date' : ''}${e.observedIssue ? ` — ${e.observedIssue}` : ''}` }), h(doc, 'button', { type: 'button', text: 'Forget', onclick: () => memoryAction(() => api.memory.removeExperience(e.id), 'Forgotten.') }))))
          : h(doc, 'p', { class: 'study-empty', text: 'Nothing yet. It builds up only from feedback you give.' }),
        L.experience.items.length ? h(doc, 'button', { type: 'button', 'data-danger': 'true', text: 'Forget all of it', onclick: () => memoryAction(() => api.memory.removeLane('experience'), 'Forgotten.') }) : null),
      section('Study sessions', h(doc, 'p', { text: L.session.current ? 'A session is open.' : 'No session open.' }), h(doc, 'button', { type: 'button', text: 'Clear session history', onclick: () => memoryAction(() => api.memory.removeLane('session'), 'Cleared.') })),
      h(doc, 'div', { class: 'study-bar' }, h(doc, 'a', { href: api.memory.exportUrl, download: 'numz-academic-notes.json', text: 'Download my academic notes' }), h(doc, 'button', { type: 'button', 'data-danger': 'true', text: 'Delete everything academic', onclick: () => { if (globalThis.confirm?.('Delete your academic profile, courses, materials, learning memories and sessions? Conversations are not touched.') !== false) memoryAction(() => api.memory.removeEverything(), 'Everything academic was deleted.') } })),
      memory.message ? h(doc, 'p', { class: 'study-note', role: 'status', text: memory.message }) : null
    )
  }

  // ---- drawing ------------------------------------------------------------------------------------------------------------------

  const clockText = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  /** What the last screen turned out to hold, in words: new things, things already seen, how it relates to the screen before. */
  const readText = (read) => {
    const sum = read.summary
    const parts = []
    if (sum) {
      if (sum.new) parts.push(`${plural(sum.new, 'new segment', 'new segments')}`)
      if (sum.grew + sum.continued) parts.push(`${sum.grew + sum.continued} continued or completed`)
      if (sum.seen) parts.push(`${sum.seen} already seen`)
    }
    const how = { overlapping: 'overlaps the last screen', revisit: 'content seen before, nothing to process again', same: 'the same content as before', 'new-screen': 'a new screen' }[read.arrival]
    if (read.status === 'questions' || read.status === 'content') return [parts.join(', '), how].filter(Boolean).join(' · ') || (read.status === 'questions' ? plural(read.count, 'new question', 'new questions') : 'new content')
    return { same: how && parts.length ? [parts.join(', '), how].join(' · ') : 'nothing new: the same content as before', none: 'nothing worth reading on the screen', unclear: 'the screen could not be understood', 'held-back': 'it could not be read this time' }[read.status] ?? ''
  }
  /** The live line under the session bar: what the watcher has done, and what the last screen it sent turned out to hold. */
  const watchNote = (state) => {
    const counts = `Looked ${state.watch.looks} times, sent ${state.watch.reported}${state.watch.skipped ? `, held back ${state.watch.skipped} times for something excluded` : ''}.`
    if (state.reading) return `${counts} Reading your screen…`
    return state.lastRead ? `${counts} Last read ${clockText(state.lastRead.at)}: ${readText(state.lastRead)}.` : counts
  }
  /** What the session tab shows, apart from the counters: the panel is redrawn only when this changes, so typing is never interrupted. */
  const signature = (state) => JSON.stringify([tab, state.phase, state.session && [state.session.id, state.session.status, state.session.sessionType], state.message, state.tone, state.busy, state.watch.available, state.watch.status, state.watch.excludedNow, state.watch.note, state.courses.map((c) => c.id), state.questions.map((q) => [q.id, q.state, q.message, q.partial ? 1 : 0, q.text.length]), state.content.map((c) => [c.id, c.status, c.partial ? 1 : 0, c.text.length]), state.lastAnswer?.answerId ?? null])
  let drawn = ''

  function render(force = false) {
    if (panel.hidden) return
    const state = controller.getState()
    const [text, tone] = indicatorText(state)
    indicator.textContent = text
    indicator.dataset.state = tone
    const note = $('studyWatchNote')
    if (note) note.textContent = watchNote(state)
    if (!force && tab !== 'session') return // the other tabs are redrawn by what the person does there, never by the session's ticking
    const key = tab === 'session' ? signature(state) : null
    if (!force && key === drawn) return
    drawn = key ?? ''
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.studyTab === tab))
    const active = doc.activeElement
    const keepFocus = active?.id === 'studyAskInput' ? { start: active.selectionStart, end: active.selectionEnd } : null
    const view = tab === 'materials' ? renderMaterials(state) : tab === 'memory' ? renderMemory() : renderSession(state)
    body.replaceChildren(h(doc, 'p', { class: 'study-message', role: 'status', 'aria-live': 'polite', 'data-tone': state.tone, text: tab === 'session' ? state.message : '' }), view)
    const input = keepFocus ? $('studyAskInput') : null
    if (input) {
      input.focus({ preventScroll: true })
      try {
        input.setSelectionRange(keepFocus.start, keepFocus.end)
      } catch {
        /* not a text field any more */
      }
    }
  }

  for (const t of tabs) {
    t.addEventListener('click', () => {
      tab = t.dataset.studyTab
      if (tab === 'memory') Object.assign(memory, { data: null, failed: false })
      if (tab === 'materials') materials.courseId = ''
      render(true)
    })
  }
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    button.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden) {
      onOpen()
      render(true)
    }
  })
  $('studyClose').addEventListener('click', () => {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
    button.focus({ preventScroll: true })
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('studyClose').click()
  })
  controller.subscribe(() => {
    const state = controller.getState()
    // The indicator in the page header is live even when the panel is closed: a session that is reading the screen is always visible.
    const [text, tone] = indicatorText(state)
    button.dataset.session = tone
    button.title = state.session ? `Study session: ${text}` : 'Study session, course materials and what NUMZ AI remembers'
    render()
  })
  globalThis.addEventListener?.('pagehide', () => controller.destroy())
  return { open: () => button.click() }
}
