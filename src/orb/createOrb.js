import { createAnimator } from '../animation/animator.js'
import { createCamera } from '../engine/camera.js'
import { createComposer } from '../engine/composer.js'
import { createRenderer } from '../engine/renderer.js'
import { createScene } from '../engine/scene.js'
import { setupResize } from '../engine/resize.js'
import { createCore } from '../core/core.js'

/**
 * The whole Three.js orb in one place: renderer, scene, camera, core, bloom composer, resize and the animator.
 *
 * This module (and everything under src/engine, src/core and src/animation) is the half megabyte of Three.js,
 * so it is only reached through orbLoader.js's `import('./createOrb.js')`, on the first entry to voice mode or
 * when the browser is idle. Do not import it from anywhere that runs at page load:
 * tests/importGraph.test.js fails if the first page load can reach it.
 *
 * @returns {{ frame(elapsedSeconds: number, deltaSeconds: number): void, dispose(): void }}
 */
export function createOrb({ canvas, stateMachine, getLevel = null, reducedMotion = () => false }) {
  const renderer = createRenderer(canvas)
  const scene = createScene()
  const camera = createCamera(window.innerWidth, window.innerHeight)

  const core = createCore()
  scene.add(core)

  const { composer, bloomPass } = createComposer(renderer, scene, camera)
  const stopResize = setupResize({ renderer, camera, composer })
  const animator = createAnimator({ core, bloomPass, stateMachine, getLevel, reducedMotion })

  return {
    frame(elapsedSeconds, deltaSeconds) {
      animator.update(elapsedSeconds, deltaSeconds)
      composer.render()
    },
    dispose() {
      stopResize()
      composer.dispose?.()
      renderer.dispose()
    }
  }
}
