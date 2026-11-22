// A stand-in for the vision provider that LOOKS at what it is sent: it decodes the picture (ImageMagick) and reports its size and the
// colours at a few points, so the end-to-end run can prove that the real pixels of the real screenshot arrived. Not part of the app.
import { execFileSync } from 'node:child_process'
import http from 'node:http'

function look(bytes) {
  const run = (args) => execFileSync('convert', ['jpg:-', ...args], { input: bytes, encoding: 'utf8' })
  const info = execFileSync('identify', ['-format', '%w %h', 'jpg:-'], { input: bytes, encoding: 'utf8' }).trim().split(' ').map(Number)
  const at = (x, y) => run(['-crop', `1x1+${Math.min(x, info[0] - 1)}+${Math.min(y, info[1] - 1)}`, '+repage', '-depth', '8', 'txt:-']).match(/#[0-9A-Fa-f]{6}/)?.[0]?.toUpperCase()
  return { width: info[0], height: info[1], center: at(Math.floor(info[0] / 2), Math.floor(info[1] / 2)), nearTopLeft: at(Math.min(40, info[0] - 1), Math.min(40, info[1] - 1)), at300: at(300, 300) }
}

export async function startFakeVision() {
  const state = { delayMs: 0, status: 200, requests: [], closedEarly: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('close', () => {
      if (!res.writableEnded) state.closedEarly++
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {}
      const system = body.messages?.[0]?.content ?? ''
      const userParts = body.messages?.[1]?.content
      const text = Array.isArray(userParts) ? userParts.find((p) => p.type === 'text')?.text ?? '' : String(userParts ?? '')
      const image = Array.isArray(userParts) ? userParts.find((p) => p.type === 'image_url')?.image_url?.url : null
      let seen = null
      if (image) {
        try {
          seen = look(Buffer.from(image.split(',')[1], 'base64'))
        } catch (e) {
          seen = { error: String(e.message).slice(0, 80) }
        }
      }
      const record = { kind: !image ? 'text' : /follow-up/i.test(system) ? 'follow-up' : 'analysis', text, seen }
      state.requests.push(record)
      setTimeout(() => {
        if (res.destroyed) return
        if (state.status !== 200) {
          res.writeHead(state.status, { 'content-type': 'application/json' })
          return res.end('{}')
        }
        const reply = !image
          ? 'ok'
          : `FAKE-VISION ${record.kind}: the picture is ${seen.width}x${seen.height}, the centre is ${seen.center}, the corner is ${seen.nearTopLeft}.${record.kind === 'follow-up' ? ' You asked: ' + text.slice(0, 80) : ''}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'fake', choices: [{ message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
      }, state.delayMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { state, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}
