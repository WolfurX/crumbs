import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Raycaster, Scene, Vector2, Vector3 } from 'three'
import { CrumbPool, buildCookie, buildHalo, lights } from '../three/cookie'
import { createView } from '../three/renderer'
import { reducedMotion } from '../lib/webgl'

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface Props {
  /** Bumps once per failed click; the cookie gives one short shake. */
  shake?: number
}

/**
 * The clicker cookie in three.js. Sways at idle, tilts under the pointer like a button being
 * touched, squashes on press and throws crumbs from the exact hit point. It listens on its own
 * host without stopping propagation, so a surrounding button still gets its click.
 */
export default function CookieScene({ shake = 0 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const shakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return
    const rm = reducedMotion()

    const scene = new Scene()
    const camera = new PerspectiveCamera(30, 1, 0.1, 20)
    camera.position.set(0, 0.55, 4.6)
    camera.lookAt(0, 0, 0)
    const cookie = buildCookie()
    const halo = buildHalo()
    const crumbs = new CrumbPool()
    scene.add(cookie.group, halo.line, crumbs.group, ...lights())

    const pointer = { x: 0, y: 0, over: false }
    let press = 0
    let pressV = 0
    let pressX = 0
    let pressY = 0
    let shakeT = 0
    const ray = new Raycaster()
    const ndc = new Vector2()
    const hit = new Vector3()
    const out = new Vector3()

    const local = (e: PointerEvent): [number, number] => {
      const r = host.getBoundingClientRect()
      return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)]
    }
    const onMove = (e: PointerEvent) => {
      ;[pointer.x, pointer.y] = local(e)
      pointer.over = true
    }
    const onLeave = () => { pointer.over = false }
    const onDown = (e: PointerEvent) => {
      const [x, y] = local(e)
      ndc.set(x, y)
      ray.setFromCamera(ndc, camera)
      const i = ray.intersectObject(cookie.disc, false)[0]
      if (i) hit.copy(i.point)
      else hit.set(x * 1.2, y * 1.2, 0.1) // the square host is a little larger than the cookie
      pressX = clamp(hit.x, -1, 1)
      pressY = clamp(hit.y, -1, 1)
      press = 1
      pressV = 0
      out.set(hit.x, hit.y, 0)
      if (out.lengthSq() < 0.01) out.set(0, 1, 0)
      out.normalize()
      crumbs.burst(hit, 8 + Math.floor(Math.random() * 4), out)
    }
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('pointerdown', onDown)
    shakeRef.current = () => { shakeT = 0.35 }

    const g = cookie.group
    const view = createView(host, canvas, (dt, t) => {
      const [w, h] = view.size()
      if (camera.aspect !== w / h) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      // the press is a spring back to rest; reduced motion gets a stiff, overdamped one
      const k = rm ? 900 : 380
      const c = rm ? 60 : 20
      pressV += (-k * press - c * pressV) * dt
      press += pressV * dt
      if (Math.abs(press) < 1e-3 && Math.abs(pressV) < 1e-3) { press = 0; pressV = 0 }

      const sway = rm ? 0 : 1
      const hx = pointer.over && !rm ? pointer.x : 0
      const hy = pointer.over && !rm ? pointer.y : 0
      const tx = sway * Math.cos((t * TAU) / 6) * 0.035 - hy * 0.16 - pressY * press * 0.22
      const ty = sway * Math.sin((t * TAU) / 6) * 0.05 + hx * 0.16 + pressX * press * 0.22
      const a = rm ? 1 : 1 - Math.exp(-dt * 12)
      g.rotation.x += (tx - g.rotation.x) * a
      g.rotation.y += (ty - g.rotation.y) * a
      g.scale.setScalar(1 - 0.06 * press)
      if (shakeT > 0) {
        shakeT = Math.max(0, shakeT - dt)
        g.rotation.z = Math.sin(shakeT * 60) * 0.05 * (shakeT / 0.35)
      } else g.rotation.z = 0
      crumbs.update(dt)
      view.renderer.render(scene, camera)
    })

    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('pointerdown', onDown)
      view.dispose()
      cookie.dispose()
      halo.dispose()
      crumbs.dispose()
    }
  }, [])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    shakeRef.current()
  }, [shake])

  return (
    <div ref={hostRef} className="cookie3d" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
