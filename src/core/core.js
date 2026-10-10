import * as THREE from 'three'
import { settings } from '../config/settings.js'

function createRadialTexture({ size = 196, stops }) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const cx = size / 2
  const cy = size / 2
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2)
  for (const s of stops) g.addColorStop(s.at, s.color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  return tex
}

function createFlareTexture() {
  return createRadialTexture({
    size: 196,
    stops: [
      { at: 0.0, color: 'rgba(255,255,255,1)' },
      { at: 0.2, color: 'rgba(235,250,255,0.98)' },
      { at: 0.42, color: 'rgba(120,215,255,0.5)' },
      { at: 0.68, color: 'rgba(70,155,255,0.22)' },
      { at: 1.0, color: 'rgba(70,155,255,0)' }
    ]
  })
}

function createFieldTexture() {
  return createRadialTexture({
    size: 240,
    stops: [
      { at: 0.0, color: 'rgba(255,255,255,0)' },
      { at: 0.28, color: 'rgba(70,185,255,0.09)' },
      { at: 0.55, color: 'rgba(50,120,255,0.08)' },
      { at: 0.78, color: 'rgba(25,70,160,0.05)' },
      { at: 1.0, color: 'rgba(0,0,0,0)' }
    ]
  })
}

function createRingTexture() {
  return createRadialTexture({
    size: 240,
    stops: [
      { at: 0.0, color: 'rgba(255,255,255,0)' },
      { at: 0.44, color: 'rgba(255,255,255,0)' },
      { at: 0.56, color: 'rgba(165,240,255,0.22)' },
      { at: 0.66, color: 'rgba(90,180,255,0.08)' },
      { at: 1.0, color: 'rgba(0,0,0,0)' }
    ]
  })
}

export function createCore() {
  const group = new THREE.Group()
  group.name = 'core'

  const innerGeo = new THREE.SphereGeometry(settings.core.radius, 48, 48)
  const innerMat = new THREE.MeshBasicMaterial({
    color: settings.colors.core,
    depthWrite: false
  })
  const inner = new THREE.Mesh(innerGeo, innerMat)
  inner.name = 'coreInner'

  const haloGeo = new THREE.SphereGeometry(settings.core.radius, 48, 48)
  const haloMat = new THREE.MeshBasicMaterial({
    color: settings.colors.coreOuter,
    transparent: true,
    opacity: settings.core.haloOpacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const halo = new THREE.Mesh(haloGeo, haloMat)
  halo.scale.setScalar(settings.core.haloScale)
  halo.name = 'coreHalo'

  const flareTexture = createFlareTexture()
  const flareMat = new THREE.SpriteMaterial({
    map: flareTexture ?? undefined,
    color: settings.colors.coreOuter,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const flare = new THREE.Sprite(flareMat)
  flare.name = 'coreFlare'
  flare.scale.set(0.95, 0.95, 1)

  const fieldTexture = createFieldTexture()
  const fieldMat = new THREE.SpriteMaterial({
    map: fieldTexture ?? undefined,
    color: settings.colors.coreOuter,
    transparent: true,
    opacity: 0.05,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const field = new THREE.Sprite(fieldMat)
  field.name = 'coreField'
  field.scale.set(2.8, 2.8, 1)

  const ringTexture = createRingTexture()
  const ringMat = new THREE.SpriteMaterial({
    map: ringTexture ?? undefined,
    color: settings.colors.coreOuter,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const ring = new THREE.Sprite(ringMat)
  ring.name = 'coreRing'
  ring.scale.set(1.38, 1.38, 1)

  // Expose stable handles for state-driven visuals (animator).
  group.userData.parts = Object.freeze({
    inner,
    halo,
    flare,
    field,
    ring,
    innerMat,
    haloMat,
    flareMat,
    fieldMat,
    ringMat
  })

  group.add(field)
  group.add(halo)
  group.add(ring)
  group.add(flare)
  group.add(inner)
  return group
}
