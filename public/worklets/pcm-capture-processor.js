/**
 * Captures raw mono float32 PCM from the mic and batches it into fixed-size
 * frames before posting to the main thread — the AudioWorklet's own
 * process() callback only ever gets 128-sample blocks (a Web Audio API
 * constant), far too small/chatty to send one-per-WebSocket-message.
 *
 * Assumes the owning AudioContext was created with sampleRate: 16000 (see
 * liveSpeechClient.js) — this processor does no resampling itself.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const frameSamples = options?.processorOptions?.frameSamples ?? 1600 // 100ms @ 16kHz
    this._frameSamples = frameSamples
    this._buffer = new Float32Array(frameSamples)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input?.[0]
    if (!channel || channel.length === 0) return true

    let read = 0
    while (read < channel.length) {
      const remaining = this._frameSamples - this._offset
      const take = Math.min(remaining, channel.length - read)
      this._buffer.set(channel.subarray(read, read + take), this._offset)
      this._offset += take
      read += take

      if (this._offset >= this._frameSamples) {
        const chunk = this._buffer.slice(0) // copy once — this._buffer keeps filling for the next frame
        this.port.postMessage(chunk.buffer, [chunk.buffer]) // transfer, not clone
        this._offset = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
