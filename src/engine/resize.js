import { settings } from '../config/settings.js'

export function setupResize({ renderer, camera, composer, domElement = window }) {
  const handleResize = () => {
    const width = domElement.innerWidth
    const height = domElement.innerHeight
    camera.aspect = width / Math.max(height, 1e-6)
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    const pixelRatio = Math.min(window.devicePixelRatio, settings.renderer.maxPixelRatio)
    renderer.setPixelRatio(pixelRatio)
    if (composer) {
      composer.setPixelRatio(pixelRatio)
      composer.setSize(width, height)
    }
  }

  domElement.addEventListener('resize', handleResize)
  handleResize()

  return () => domElement.removeEventListener('resize', handleResize)
}
