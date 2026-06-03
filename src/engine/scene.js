import * as THREE from 'three'
import { settings } from '../config/settings.js'

export function createScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(settings.colors.background)
  return scene
}
