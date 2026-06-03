import * as THREE from 'three'
import { settings } from '../config/settings.js'

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function pickProfile(state) {
  const states = settings.assistantVisual?.states
  const aliases = {
    TRANSCRIBING: 'LISTENING',
    THINKING: 'PROCESSING',
    RETRIEVING_MEMORY: 'PROCESSING',
    TOOL_EXECUTION: 'PROCESSING',
    GENERATING: 'PROCESSING',
    STREAMING: 'PROCESSING',
    INTERRUPTED: 'ERROR',
    ERROR_RECOVERY: 'ERROR'
  }
  return states?.[state] ?? states?.[aliases[state]] ?? states?.IDLE
}

export function createAnimator({ core, bloomPass, stateMachine }) {
  const { animation: anim, core: coreCfg, bloom: bloomCfg, assistantVisual } = settings
  const baseBloomStrength = bloomCfg.strength

  const parts = core?.userData?.parts
  const haloMat = parts?.haloMat ?? core.getObjectByName('coreHalo')?.material
  const flareMat = parts?.flareMat ?? core.getObjectByName('coreFlare')?.material
  const fieldMat = parts?.fieldMat ?? core.getObjectByName('coreField')?.material
  const ringMat = parts?.ringMat ?? core.getObjectByName('coreRing')?.material
  const innerMat = parts?.innerMat ?? core.getObjectByName('coreInner')?.material

  const baseHaloOpacity = haloMat?.opacity ?? settings.core.haloOpacity
  const baseFieldOpacity = fieldMat?.opacity ?? 0.12
  const baseRingOpacity = ringMat?.opacity ?? 0.18
  const baseFlareOpacity = flareMat?.opacity ?? 0.75

  const live = {
    coreColor: new THREE.Color(settings.colors.core),
    outerColor: new THREE.Color(settings.colors.coreOuter),
    pulseSpeedMult: 1,
    pulseStrengthMult: 1,
    bloomStrengthMult: 1,
    haloOpacityMult: 1,
    fieldOpacityMult: 1,
    ringOpacityMult: 1,
    flareOpacityMult: 1
  }

  return {
    update(timeSeconds, deltaSeconds) {
      const dt = Math.min(Math.max(deltaSeconds, 0), 0.05)

      core.rotation.y += anim.rotationSpeed * dt

      const state = stateMachine?.getState?.() ?? 'IDLE'
      const profile = pickProfile(state)
      const tau = Math.max(0.001, assistantVisual?.stateTransitionSeconds ?? 0.22)
      const a = clamp01(dt / tau)

      if (profile) {
        live.coreColor.lerp(new THREE.Color(profile.coreColor), a)
        live.outerColor.lerp(new THREE.Color(profile.outerColor), a)
        live.pulseSpeedMult = lerp(live.pulseSpeedMult, profile.pulseSpeedMult ?? 1, a)
        live.pulseStrengthMult = lerp(live.pulseStrengthMult, profile.pulseStrengthMult ?? 1, a)
        live.bloomStrengthMult = lerp(live.bloomStrengthMult, profile.bloomStrengthMult ?? 1, a)
        live.haloOpacityMult = lerp(live.haloOpacityMult, profile.haloOpacityMult ?? 1, a)
        live.fieldOpacityMult = lerp(live.fieldOpacityMult, profile.fieldOpacityMult ?? 1, a)
        live.ringOpacityMult = lerp(live.ringOpacityMult, profile.ringOpacityMult ?? 1, a)
        live.flareOpacityMult = lerp(live.flareOpacityMult, profile.flareOpacityMult ?? 1, a)
      }

      if (innerMat?.color) innerMat.color.copy(live.coreColor)
      if (haloMat?.color) haloMat.color.copy(live.outerColor)
      if (flareMat?.color) flareMat.color.copy(live.outerColor)
      if (fieldMat?.color) fieldMat.color.copy(live.outerColor)
      if (ringMat?.color) ringMat.color.copy(live.outerColor)

      const w = coreCfg.pulseSpeed * live.pulseSpeedMult
      const waveA = Math.sin(timeSeconds * w)
      const waveB = Math.sin(timeSeconds * w * anim.pulseSecondaryFactor + 1.1)
      const organic = (1 - anim.pulseOrganicBlend) * waveA + anim.pulseOrganicBlend * waveB
      const eased = THREE.MathUtils.smoothstep(organic, -1, 1)
      const breathe = (eased - 0.5) * 2

      // Speaking gets a slightly sharper rhythmic component.
      const speakingBeat = state === 'SPEAKING' ? Math.sin(timeSeconds * (w * 2.1) + 0.35) : 0
      const beatMix = state === 'SPEAKING' ? 0.35 : 0
      const pulseWave = (1 - beatMix) * breathe + beatMix * speakingBeat

      const corePulse = 1 + pulseWave * coreCfg.pulseStrength * live.pulseStrengthMult
      core.scale.setScalar(corePulse)

      core.position.y =
        Math.sin(timeSeconds * anim.floatSpeed + 0.4) * anim.floatAmplitude

      if (haloMat) {
        const haloLive =
          1 + Math.sin(timeSeconds * w * 0.85 + 0.6) * coreCfg.haloLiveDepth
        haloMat.opacity = THREE.MathUtils.clamp(
          baseHaloOpacity * live.haloOpacityMult * haloLive,
          0.05,
          0.95
        )
      }

      const flare = core.getObjectByName('coreFlare')
      if (flare?.material) {
        const slow = Math.sin(timeSeconds * anim.flareSlowHz * Math.PI * 2)
        const fast = Math.sin(timeSeconds * anim.flareFastHz * Math.PI * 2)
        const mix = slow * 0.62 + fast * 0.38
        const sm = THREE.MathUtils.smoothstep(mix, -1, 1)
        flare.material.opacity =
          (anim.flareOpacityBase + (sm - 0.5) * 2 * anim.flareOpacitySwing) * live.flareOpacityMult
        // subtle "presence" scaling with state
        const baseScale = 0.95
        const extra = (live.flareOpacityMult - 1) * 0.22
        flare.scale.setScalar(baseScale + extra)
      }

      const ring = core.getObjectByName('coreRing')
      if (ring?.material) {
        const ringW = state === 'PROCESSING' ? w * 0.55 : w * 0.38
        const ringWave = THREE.MathUtils.smoothstep(Math.sin(timeSeconds * ringW + 0.9), -1, 1)
        ring.material.opacity = THREE.MathUtils.clamp(
          baseRingOpacity * live.ringOpacityMult * (0.78 + ringWave * 0.5),
          0.02,
          0.7
        )
        const ringPulse = 1 + (ringWave - 0.5) * 2 * 0.04 * live.pulseStrengthMult
        ring.scale.setScalar(1.38 * ringPulse)
      }

      const field = core.getObjectByName('coreField')
      if (field?.material) {
        const fw = w * 0.22
        const f = THREE.MathUtils.smoothstep(Math.sin(timeSeconds * fw + 1.4), -1, 1)
        field.material.opacity = THREE.MathUtils.clamp(
          baseFieldOpacity * live.fieldOpacityMult * (0.82 + f * 0.35),
          0.01,
          0.35
        )
        const fieldPulse = 1 + (f - 0.5) * 2 * 0.02
        field.scale.setScalar(2.8 * fieldPulse)
      }

      if (bloomPass) {
        const bloomWave = 1 + Math.sin(timeSeconds * 0.65) * bloomCfg.liveModulation
        bloomPass.strength = baseBloomStrength * bloomWave * live.bloomStrengthMult
      }
    }
  }
}
