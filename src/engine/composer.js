import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { settings } from '../config/settings.js'

export function createComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer)

  const renderPass = new RenderPass(scene, camera)

  const size = new THREE.Vector2()
  renderer.getSize(size)
  const bloomRes = size.clone().multiplyScalar(settings.bloom.resolutionScale)
  const bloomPass = new UnrealBloomPass(
    bloomRes,
    settings.bloom.strength,
    settings.bloom.radius,
    settings.bloom.threshold
  )

  const outputPass = new OutputPass()

  composer.addPass(renderPass)
  composer.addPass(bloomPass)
  composer.addPass(outputPass)

  return { composer, bloomPass }
}
