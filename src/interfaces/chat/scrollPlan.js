/**
 * Where to scroll the conversation so that one message is in the middle of what the person sees.
 * Pure arithmetic (no DOM, tested); chatView.js measures the page and applies the answer.
 *
 * A message that fits is put in the middle. One taller than the view cannot be: it is put at the top, so that it is read from its
 * first line. The newest message has nothing below it to scroll past, so it can only reach the middle if there is room made for it:
 * `extra` is how much blank space to add under the conversation for that (and is 0 when the thread already goes on far enough).
 *
 * @param {object} m measurements in pixels
 * @param {number} m.itemTop where the message starts, counted from the top of the scrolling content
 * @param {number} m.itemHeight how tall it is
 * @param {number} m.view how tall the visible part of the conversation is
 * @param {number} m.scrollHeight how tall the content is, without any blank space added by an earlier call
 * @param {number} [m.margin] breathing room above a message that is put at the top
 * @returns {{ scrollTop: number, extra: number, tall: boolean }}
 */
export function planCenter({ itemTop, itemHeight, view, scrollHeight, margin = 16 }) {
  const tall = itemHeight > view - 2 * margin
  const want = Math.max(0, tall ? itemTop - margin : itemTop - (view - itemHeight) / 2)
  const room = Math.max(0, scrollHeight - view) // the furthest the content can scroll as it is
  const extra = want > room ? Math.ceil(want - room) : 0
  return { scrollTop: Math.round(want), extra, tall }
}
