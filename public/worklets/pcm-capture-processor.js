/**
 * Captures raw mono float32 PCM from the mic and batches it into fixed-size
 * frames before posting to the main thread — the AudioWorklet's own
 * process() callback only ever gets 128-sample blocks (a Web Audio API
 * constant), far too small/chatty to send one-per-WebSocket-message.
 *
 * Assumes the owning AudioContext was created with sampleRate: 16000 (see
 * liveSpeechClient.js) — this processor does no resampling itself.
 *
 * Inputs: input 0 is the audio to record (the mix, when two sources are recorded). With
 * processorOptions.reportLevels, inputs 1 and 2 are the microphone and the shared tab on their own: they are
 * only measured, never recorded, and each posted frame becomes { frame, mic, tab } where mic and tab are the
 * RMS of that input over exactly the samples of that frame (null when nothing was connected). Without it, each
 * posted message is the bare ArrayBuffer of the frame, exactly as before.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = options?.processorOptions ?? {}
    const frameSamples = processorOptions.frameSamples ?? 1600 // 100ms @ 16kHz
    this._frameSamples = frameSamples
    this._buffer = new Float32Array(frameSamples)
    this._offset = 0
    this._reportLevels = processorOptions.reportLevels === true
    this._micSum = 0
    this._micCount = 0
    this._tabSum = 0
    this._tabCount = 0
  }

  /** Adds samples [from, to) of `channel` to a running sum of squares; a missing channel adds nothing. */
  _measure(channel, from, to, sum, count) {
    if (!channel) return [sum, count]
    const end = Math.min(to, channel.length)
    for (let i = from; i < end; i++) sum += channel[i] * channel[i]
    return [sum, count + Math.max(0, end - from)]
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input?.[0]
    if (!channel || channel.length === 0) return true

    const mic = this._reportLevels ? inputs[1]?.[0] : null
    const tab = this._reportLevels ? inputs[2]?.[0] : null

    let read = 0
    while (read < channel.length) {
      const remaining = this._frameSamples - this._offset
      const take = Math.min(remaining, channel.length - read)
      this._buffer.set(channel.subarray(read, read + take), this._offset)
      if (this._reportLevels) {
        ;[this._micSum, this._micCount] = this._measure(mic, read, read + take, this._micSum, this._micCount)
        ;[this._tabSum, this._tabCount] = this._measure(tab, read, read + take, this._tabSum, this._tabCount)
      }
      this._offset += take
      read += take

      if (this._offset >= this._frameSamples) {
        const chunk = this._buffer.slice(0) // copy once — this._buffer keeps filling for the next frame
        if (this._reportLevels) {
          this.port.postMessage(
            {
              frame: chunk.buffer,
              mic: this._micCount ? Math.sqrt(this._micSum / this._micCount) : null,
              tab: this._tabCount ? Math.sqrt(this._tabSum / this._tabCount) : null
            },
            [chunk.buffer]
          ) // transfer, not clone
          this._micSum = 0
          this._micCount = 0
          this._tabSum = 0
          this._tabCount = 0
        } else {
          this.port.postMessage(chunk.buffer, [chunk.buffer]) // transfer, not clone
        }
        this._offset = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
