/**
 * What a call costs, estimated, in millionths of a US dollar. The prices are the operator's to set (they depend on the provider and
 * the plan); with none set the cost is unknown (null) and thresholds apply to tokens, pictures and seconds instead.
 *
 *   AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK              text model, US dollars per million tokens
 *   AI_PRICE_VISION_INPUT_PER_MTOK / AI_PRICE_VISION_OUTPUT_PER_MTOK  the vision model (defaults to the text prices)
 *   AI_PRICE_STT_PER_MINUTE                                         cloud speech-to-text, US dollars per minute
 */

const number = (value) => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** A rough size when the provider reports none: about four characters a token. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

export function costMicroUsd({ kind, tokensIn = 0, tokensOut = 0, audioSeconds = 0 }, env = process.env) {
  const vision = kind === 'vision_read' || kind === 'vision_answer' || kind === 'academic_read'
  const inPrice = number(vision ? env.AI_PRICE_VISION_INPUT_PER_MTOK ?? env.AI_PRICE_INPUT_PER_MTOK : env.AI_PRICE_INPUT_PER_MTOK)
  const outPrice = number(vision ? env.AI_PRICE_VISION_OUTPUT_PER_MTOK ?? env.AI_PRICE_OUTPUT_PER_MTOK : env.AI_PRICE_OUTPUT_PER_MTOK)
  const sttPrice = number(env.AI_PRICE_STT_PER_MINUTE)
  let total = 0
  let known = false
  if (kind === 'stt') {
    if (sttPrice !== null) {
      total += sttPrice * (audioSeconds / 60)
      known = true
    }
  } else if (inPrice !== null || outPrice !== null) {
    total += (inPrice ?? 0) * (tokensIn / 1_000_000) + (outPrice ?? 0) * (tokensOut / 1_000_000)
    known = true
  }
  return known ? Math.round(total * 1_000_000) : null
}
