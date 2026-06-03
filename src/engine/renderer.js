import * as THREE from 'three'
import { settings } from '../config/settings.js'

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: settings.renderer.antialias,
    alpha: settings.renderer.alpha,
    powerPreference: 'high-performance'
  })

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.renderer.maxPixelRatio))
  renderer.setSize(window.innerWidth, window.innerHeight)

  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = settings.renderer.toneMappingExposure

  renderer.setClearColor(
    new THREE.Color(settings.colors.background),
    settings.renderer.opaqueClearAlpha
  )

  return renderer
}
