import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Scene } from 'three'
import { buildHero } from '../three/hero'
import { createView } from '../three/renderer'
import { reducedMotion } from '../lib/webgl'

const DIST = 5.04 // shows 2.7 world units of height at a 30 degree fov, the drawing's full frame

/** The hero drawing in three.js: crumbs travel the trails, the camera leans with the pointer. Desktop only, like the SVG it replaces. */
export default function HeroScene() {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const still = reducedMotion()
    const scene = new Scene()
    const camera = new PerspectiveCamera(30, 16 / 9, 0.1, 20)
    const hero = buildHero()
    scene.add(hero.group)

    // the whole hero section drives the lean, so moving across the headline already moves the scene
    const area = (host.closest('.hero') as HTMLElement | null) ?? host
    const pointer = { x: 0, y: 0 }
    const onMove = (e: PointerEvent) => {
      const r = area.getBoundingClientRect()
      pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
      pointer.y = -(((e.clientY - r.top) / r.height) * 2 - 1)
    }
    const onLeave = () => { pointer.x = 0; pointer.y = 0 }
    if (!still) {
      area.addEventListener('pointermove', onMove)
      area.addEventListener('pointerleave', onLeave)
    }

    let yaw = 0
    let pitch = 0
    const view = createView(host, canvas, (dt, t) => {
      const [w, h] = view.size()
      if (camera.aspect !== w / h) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      const a = 1 - Math.exp(-dt * 6)
      yaw += (pointer.x * 0.1 - yaw) * a
      pitch += (pointer.y * 0.06 - pitch) * a
      camera.position.set(Math.sin(yaw) * DIST, Math.sin(pitch) * DIST, Math.cos(yaw) * Math.cos(pitch) * DIST)
      camera.lookAt(0, 0, 0)
      hero.cookie.rotation.y += (pointer.x * 0.14 - hero.cookie.rotation.y) * a
      hero.cookie.rotation.x += (-pointer.y * 0.1 - hero.cookie.rotation.x) * a
      hero.update(dt, t, still)
      view.renderer.render(scene, camera)
    })

    return () => {
      area.removeEventListener('pointermove', onMove)
      area.removeEventListener('pointerleave', onLeave)
      view.dispose()
      hero.dispose()
    }
  }, [])

  return (
    <div ref={hostRef} className="hero-3d" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
