import { useEffect, useRef } from 'react'
import { OrthographicCamera, Scene } from 'three'
import { buildBakery } from '../three/bakery'
import { createView } from '../three/renderer'
import { reducedMotion } from '../lib/webgl'

/**
 * The bakery around the clicker cookie: every baker tier as line art, drawn solid once you own
 * one. It sits behind the cookie and takes no pointer events, so the cookie keeps every click.
 */
export default function BakeryScene({ owned }: { owned: number[] }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const setOwned = useRef<(owned: number[]) => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const still = reducedMotion()
    const scene = new Scene()
    // one world unit is one CSS pixel, origin at the centre of the host
    const camera = new OrthographicCamera(-1, 1, 1, -1, -500, 500)
    const bakery = buildBakery()
    scene.add(bakery.group)
    setOwned.current = bakery.setOwned

    let laidW = 0
    let laidH = 0
    const view = createView(host, canvas, (dt, t) => {
      const [w, h] = view.size()
      if (w !== laidW || h !== laidH) {
        laidW = w
        laidH = h
        camera.left = -w / 2
        camera.right = w / 2
        camera.top = h / 2
        camera.bottom = -h / 2
        camera.updateProjectionMatrix()
        bakery.layout(w, h)
      }
      bakery.update(dt, t, still)
      view.renderer.render(scene, camera)
    })

    return () => {
      view.dispose()
      bakery.dispose()
    }
  }, [])

  useEffect(() => {
    setOwned.current(owned)
  }, [owned])

  return (
    <div ref={hostRef} className="bakery3d" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
