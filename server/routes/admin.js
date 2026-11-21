import { Router } from 'express'
import { sendAuthError as deny } from '../auth/authPrimitives.js'

/**
 * Administration of NUMZ AI itself, for people with the `ai.admin` capability (NUMZLAB role admin). What it can do, and what it cannot:
 *
 *   can      see how much each person used (counts and estimated cost, never any text), list the people and their live sessions,
 *            end a person's NUMZ AI sessions, pause and resume the AI (everything, or chat / voice / camera), run the diagnostics
 *   cannot   read anyone's conversations, prompts, pictures or audio. There is no route for it, and the people's own routes only ever
 *            answer for the signed-in person. (Whoever has the host can still open the database file; see docs/ai-identity.md.)
 *
 * Mounted at /api/v1/admin behind requireSession('ai.admin'), which also demands the CSRF token on every change.
 */

export function createAdminRouter({ access, repo, meter, health, probe }) {
  const router = Router()

  router.get('/users', (_req, res) => {
    res.json({ users: repo.listUsers() })
  })

  router.get('/usage', (req, res) => {
    const days = Math.max(1, Math.min(90, Number.parseInt(String(req.query.days ?? '7'), 10) || 7))
    res.json({ days, people: meter.report(days).map((row) => ({ ...row, estCostUsd: row.costMicroUsd ? row.costMicroUsd / 1_000_000 : null })), flags: meter.flags() })
  })

  router.post('/users/:id/revoke', (req, res) => {
    const id = String(req.params.id)
    if (!repo.getUser(id)) return deny(res, req, 404, 'not-found', 'No such person.')
    const sessions = access.revokeUser(id, 'revoked by an administrator')
    repo.audit({ event: 'admin.revoke_user', userId: req.identity.userId, sessionRef: req.identity.sessionRef, ip: req.ip, requestId: req.id, detail: { target: id, sessions } })
    res.json({ revoked: sessions })
  })

  const flag = (on) => (req, res) => {
    const feature = req.body?.feature === undefined ? 'all' : String(req.body.feature)
    if (!meter.FEATURES.includes(feature)) return deny(res, req, 400, 'bad-feature', `feature must be one of ${meter.FEATURES.join(', ')}`)
    if (on) meter.pause(feature, req.identity.email)
    else meter.resume(feature, req.identity.email)
    repo.audit({ event: on ? 'ai.paused' : 'ai.resumed', userId: req.identity.userId, sessionRef: req.identity.sessionRef, ip: req.ip, requestId: req.id, detail: { feature } })
    res.json(meter.flags())
  }
  router.post('/pause', flag(true))
  router.post('/resume', flag(false))

  router.get('/health', (_req, res) => res.json(health()))

  router.get('/probe', async (_req, res, next) => {
    try {
      const result = await probe()
      res.status(result.ok ? 200 : result.configured ? 502 : 503).json(result)
    } catch (err) {
      next(err)
    }
  })

  return router
}
