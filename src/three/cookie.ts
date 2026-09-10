import {
  BufferGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineDashedMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { COOKIE_CHIPS } from '../lib/cookie-chips'

// The site's line-art palette. One theme, so constants, the same way hero.svg carries them.
export const ACCENT = 0xe0a54a
export const HAIRLINE = 0x3a342b
const DISC = 0x4a3a20
const DISC_H = 0.16

export interface Cookie {
  group: Group
  /** The front face, for raycasting a press. */
  disc: Mesh
  dispose(): void
}

/** The cookie as an object: one unit radius, facing +z. Matte disc, accent rim as the stroke, six chips. */
export function buildCookie(rimRadius = 0.014): Cookie {
  const group = new Group()
  const discGeo = new CylinderGeometry(1, 1, DISC_H, 72)
  const discMat = new MeshStandardMaterial({ color: DISC, roughness: 1, metalness: 0 })
  const disc = new Mesh(discGeo, discMat)
  disc.rotation.x = Math.PI / 2
  group.add(disc)

  const rimGeo = new TorusGeometry(1, rimRadius, 8, 128)
  const rimMat = new MeshBasicMaterial({ color: ACCENT })
  const rim = new Mesh(rimGeo, rimMat)
  rim.position.z = DISC_H / 2
  group.add(rim)

  const chipGeo = new SphereGeometry(1, 24, 16)
  const chipMat = new MeshStandardMaterial({ color: ACCENT, roughness: 0.55, metalness: 0 })
  for (const [dx, dy, dr] of COOKIE_CHIPS) {
    const chip = new Mesh(chipGeo, chipMat)
    chip.scale.set(dr, dr, dr * 0.55) // a dome, not a marble: the flat chips of the SVGs with a little relief
    chip.position.set(dx, -dy, DISC_H / 2 + dr * 0.12)
    group.add(chip)
  }

  return {
    group,
    disc,
    dispose() {
      discGeo.dispose(); discMat.dispose(); rimGeo.dispose(); rimMat.dispose(); chipGeo.dispose(); chipMat.dispose()
    },
  }
}

/** The dashed hairline ring the SVGs draw around a cookie. */
export function buildHalo(r = 1.15, dashSize = 0.031, gapSize = 0.073): { line: LineLoop; dispose(): void } {
  const pts: Vector3[] = []
  for (let i = 0; i < 160; i++) {
    const a = (i / 160) * Math.PI * 2
    pts.push(new Vector3(Math.cos(a) * r, Math.sin(a) * r, 0))
  }
  const geo = new BufferGeometry().setFromPoints(pts)
  const mat = new LineDashedMaterial({ color: HAIRLINE, dashSize, gapSize })
  const line = new LineLoop(geo, mat)
  line.computeLineDistances()
  return { line, dispose() { geo.dispose(); mat.dispose() } }
}

/** Low light: the disc stays dark, only the chips catch a highlight. */
export function lights(): [HemisphereLight, DirectionalLight] {
  const hemi = new HemisphereLight(0xece6da, 0x2a2318, 1.6)
  const key = new DirectionalLight(0xfff3e0, 1.0)
  key.position.set(-2, 3, 4)
  return [hemi, key]
}

interface Crumb { mesh: Mesh; vel: Vector3; spin: Vector3; age: number; life: number }

/** Pooled crumbs thrown from a press point: fall under gravity, shrink away. */
export class CrumbPool {
  readonly group = new Group()
  private items: Crumb[] = []
  private geo = new TetrahedronGeometry(0.05, 0)
  private mat = new MeshBasicMaterial({ color: ACCENT })
  private max = 48

  burst(at: Vector3, n: number, out: Vector3) {
    for (let i = 0; i < n; i++) {
      const c = this.take()
      c.mesh.position.copy(at).add(new Vector3(rnd(-0.1, 0.1), rnd(-0.1, 0.1), 0.03))
      c.vel.copy(out).multiplyScalar(rnd(0.5, 1.5)).add(new Vector3(0, rnd(0.9, 2.1), rnd(0.5, 1.4)))
      c.spin.set(rnd(-8, 8), rnd(-8, 8), rnd(-8, 8))
      c.age = 0
      c.life = rnd(0.55, 0.8)
      c.mesh.visible = true
    }
  }

  update(dt: number) {
    for (const c of this.items) {
      if (!c.mesh.visible) continue
      c.age += dt
      if (c.age >= c.life) { c.mesh.visible = false; continue }
      c.vel.y -= 7 * dt
      c.mesh.position.addScaledVector(c.vel, dt)
      c.mesh.rotation.x += c.spin.x * dt
      c.mesh.rotation.y += c.spin.y * dt
      c.mesh.scale.setScalar(1.15 * (1 - c.age / c.life))
    }
  }

  private take(): Crumb {
    let c = this.items.find((i) => !i.mesh.visible)
    if (!c && this.items.length < this.max) {
      c = { mesh: new Mesh(this.geo, this.mat), vel: new Vector3(), spin: new Vector3(), age: 0, life: 1 }
      this.group.add(c.mesh)
      this.items.push(c)
    }
    if (!c) c = this.items.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b))
    return c
  }

  dispose() { this.geo.dispose(); this.mat.dispose() }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
