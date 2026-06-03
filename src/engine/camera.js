import * as THREE from 'three'
import { settings } from '../config/settings.js'

export function createCamera(width, height) {
  const aspect = width / Math.max(height, 1e-6)
  const camera = new THREE.PerspectiveCamera(
    settings.camera.fov,
    aspect,
    settings.camera.near,
    settings.camera.far
  )
  camera.position.set(0, settings.camera.positionY, settings.camera.positionZ)
  return camera
}
