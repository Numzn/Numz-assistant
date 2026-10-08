import { Router } from 'express'

export function createMeetingsRouter({ meetingService }) {
  const router = Router()

  router.post('/', (req, res) => {
    res.status(201).json(meetingService.createMeeting(req.body?.metadata ?? {}))
  })

  router.get('/:meetingId', (req, res) => {
    res.json(meetingService.getMeeting(req.params.meetingId))
  })

  router.post('/:meetingId/start', (req, res) => {
    res.json(meetingService.startMeeting(req.params.meetingId))
  })

  router.post('/:meetingId/pause', (req, res) => {
    res.json(meetingService.pauseMeeting(req.params.meetingId))
  })

  router.post('/:meetingId/resume', (req, res) => {
    res.json(meetingService.resumeMeeting(req.params.meetingId))
  })

  router.post('/:meetingId/recover', (req, res) => {
    res.json(meetingService.recoverMeeting(req.params.meetingId))
  })

  router.post('/:meetingId/sessions', (req, res) => {
    res.status(201).json(meetingService.attachSpeechSession(req.params.meetingId))
  })

  router.post('/:meetingId/end', (req, res) => {
    meetingService.beginFinalization(req.params.meetingId)
    const completed = meetingService.completeMeeting(req.params.meetingId)
    res.json(completed)
  })

  router.post('/:meetingId/transcript/final', (req, res) => {
    const result = meetingService.appendFinalSegment(req.params.meetingId, req.body?.segment)
    res.status(result.inserted ? 201 : 200).json(result)
  })

  router.get('/:meetingId/transcript', (req, res) => {
    res.json({ meetingId: req.params.meetingId, segments: meetingService.getTranscript(req.params.meetingId) })
  })

  return router
}
