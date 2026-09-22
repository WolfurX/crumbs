import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CubicBezierCurve3,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector3,
} from 'three'
import { ACCENT, HAIRLINE } from './cookie'

const MUTED = 0x877f73
const TAU = Math.PI * 2

/** Below this width the bakers move from beside the cookie to a shelf under it. Matches `.bakery-stage` in styles.css. */
export const FLANK_MIN = 540
/** Height of that shelf, px. Matches `.with-bakery .cookie-wrap` in styles.css. */
export const SHELF = 150
/** The disc fills this share of the cookie canvas (radius 1 seen from 4.6 at a 30° field of view). */
const COOKIE_FILL = 1 / (4.6 * Math.tan(Math.PI / 12))

type V = [number, number, number]
const v = ([x, y, z]: V) => new Vector3(x, y, z)
const ring = (r: number, n: number, [cx, cy, cz]: V): V[] => Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * TAU) * r, cy + Math.sin((i / n) * TAU) * r, cz])
const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

interface Baker {
  /** Position and size in the layout, mirrored on the right-hand side. */
  slot: Group
  /** Arrival pop and idle motion. */
  body: Group
  outlines: (LineSegments | Line)[]
  accents: Object3D[]
  animate(t: number): void
  owned: number
  pop: number
  popV: number
  trail: { line: Line; curve: CubicBezierCurve3; crumb: Mesh } | null
}

export interface Bakery {
  group: Group
  /** The player's units per tier. The first call places them; later ones pop what was bought. */
  setOwned(owned: number[]): void
  layout(w: number, h: number): void
  update(dt: number, t: number, still: boolean): void
  dispose(): void
}

/**
 * The eight bakers of Crumb Clicker as line art around the cookie, in pixel units for an
 * orthographic camera. A tier you own is drawn solid with its accent details moving and sends a
 * crumb to the cookie along a dashed trail; a tier still to buy is a dashed outline.
 */
export function buildBakery(): Bakery {
  const group = new Group()
  const trash: { dispose(): void }[] = []
  const solid = new LineBasicMaterial({ color: MUTED })
  const ghost = new LineDashedMaterial({ color: HAIRLINE, dashSize: 0.035, gapSize: 0.045 })
  const accent = new MeshBasicMaterial({ color: ACCENT, side: DoubleSide })
  const dim = new MeshBasicMaterial({ color: HAIRLINE, side: DoubleSide })
  const smoke = new MeshBasicMaterial({ color: MUTED, side: DoubleSide })
  const trailMat = new LineDashedMaterial({ color: HAIRLINE, dashSize: 3, gapSize: 5 })
  const crumbGeo = new SphereGeometry(1, 10, 8)
  trash.push(solid, ghost, accent, dim, smoke, trailMat, crumbGeo)

  // part helpers: every outline can switch between solid and dashed, every accent hides on a ghost
  let outlines: (LineSegments | Line)[] = []
  let accents: Object3D[] = []
  let into: Group = group
  const own = <T extends { dispose(): void }>(x: T) => {
    trash.push(x)
    return x
  }
  const at = <T extends Object3D>(o: T, p: V = [0, 0, 0]) => {
    o.position.set(...p)
    into.add(o)
    return o
  }
  const edges = (geo: BufferGeometry, p?: V) => {
    const seg = new LineSegments(own(new EdgesGeometry(own(geo), 1)), solid)
    seg.computeLineDistances()
    outlines.push(seg)
    return at(seg, p)
  }
  const poly = (pts: V[], closed = false) => {
    const geo = own(new BufferGeometry().setFromPoints(pts.map(v)))
    const l = closed ? new LineLoop(geo, solid) : new Line(geo, solid)
    l.computeLineDistances()
    outlines.push(l)
    return at(l)
  }
  const mark = <T extends Object3D>(o: T) => {
    accents.push(o)
    return o
  }
  const fill = (geo: BufferGeometry, p?: V, mat: Material = accent) => mark(at(new Mesh(own(geo), mat), p))
  const stroke = (a: V, b: V, r = 0.02) => {
    const d = v(b).sub(v(a))
    const m = new Mesh(own(new CylinderGeometry(r, r, d.length(), 6)), accent)
    m.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize()))
    return mark(at(m, v(a).add(v(b)).multiplyScalar(0.5).toArray() as V))
  }

  // Each builder draws into a unit box centred on the origin and returns its idle motion.
  const builders: ((body: Group) => (t: number) => void)[] = [
    // Cursor: an arrow pointer that taps toward the cookie
    (body) => {
      const s = new Shape()
      const pts: [number, number][] = [[0, 0.42], [0, -0.2], [0.13, -0.08], [0.24, -0.34], [0.34, -0.3], [0.23, -0.04], [0.4, -0.04]]
      s.moveTo(...pts[0])
      for (const p of pts.slice(1)) s.lineTo(...p)
      s.closePath()
      const arrow = new Group()
      into = arrow
      edges(new ExtrudeGeometry(s, { depth: 0.08, bevelEnabled: false }), [-0.17, -0.04, -0.04])
      const tip = fill(new CircleGeometry(0.05, 16), [-0.17, 0.38, 0.05])
      into = body
      arrow.rotation.z = -0.9
      body.add(arrow)
      const dir = new Vector3(0, 1, 0).applyAxisAngle(new Vector3(0, 0, 1), -0.9)
      return (t) => {
        const tap = Math.pow(Math.max(0, Math.sin((t * TAU) / 1.6)), 12)
        arrow.position.copy(dir).multiplyScalar(0.07 * tap)
        tip.scale.setScalar(1 + tap * 0.8)
      }
    },
    // Grandma: bun, head, a six-sided skirt, rocking with an accent rolling pin
    (body) => {
      poly(ring(0.12, 24, [0, 0.2, 0]), true)
      poly(ring(0.065, 16, [0, 0.36, 0]), true)
      edges(new CylinderGeometry(0.1, 0.28, 0.46, 6), [0, -0.23, 0])
      stroke([-0.24, -0.1, 0.26], [0.24, -0.1, 0.26], 0.035)
      stroke([-0.34, -0.1, 0.26], [-0.24, -0.1, 0.26], 0.014)
      stroke([0.24, -0.1, 0.26], [0.34, -0.1, 0.26], 0.014)
      return (t) => { body.rotation.z = Math.sin((t * TAU) / 3) * 0.08 }
    },
    // Oven: a box with a door window glowing, two knobs
    () => {
      edges(new BoxGeometry(0.8, 0.66, 0.5), [0, -0.1, 0])
      poly([[-0.26, -0.34, 0.251], [0.26, -0.34, 0.251], [0.26, 0.02, 0.251], [-0.26, 0.02, 0.251]], true)
      const glowMat = own(new MeshBasicMaterial({ color: ACCENT, side: DoubleSide, transparent: true, opacity: 0.4 }))
      fill(new PlaneGeometry(0.46, 0.3), [0, -0.16, 0.249], glowMat)
      fill(new CircleGeometry(0.04, 12), [-0.2, 0.13, 0.251])
      fill(new CircleGeometry(0.04, 12), [0.2, 0.13, 0.251])
      return (t) => { glowMat.opacity = 0.3 + 0.25 * (0.5 + 0.5 * Math.sin((t * TAU) / 2.4)) }
    },
    // Bakery: a shopfront with a pitched roof, an accent awning and a swinging cookie sign
    (body) => {
      edges(new BoxGeometry(0.8, 0.5, 0.45), [0, -0.25, 0])
      const roof = new CylinderGeometry(0.52, 0.52, 0.45, 3, 1)
      roof.rotateX(-Math.PI / 2)
      roof.scale(1, 0.45, 1)
      edges(roof, [0, 0.117, 0])
      stroke([-0.4, -0.03, 0.235], [0.4, -0.03, 0.235], 0.022)
      poly([[-0.3, -0.5, 0.226], [-0.3, -0.2, 0.226], [-0.1, -0.2, 0.226], [-0.1, -0.5, 0.226]])
      const sign = new Group()
      sign.position.set(0.2, -0.1, 0.25)
      into = sign
      poly([[0, 0, 0], [0, -0.08, 0]])
      fill(new CircleGeometry(0.075, 20), [0, -0.15, 0])
      into = body
      body.add(sign)
      return (t) => { sign.rotation.z = Math.sin((t * TAU) / 3.2) * 0.14 }
    },
    // Factory: sawtooth roof, lit windows, a chimney puffing
    () => {
      edges(new BoxGeometry(0.9, 0.42, 0.45), [0, -0.29, 0])
      for (const z of [0.225, -0.225]) poly([[-0.45, -0.08, z], [-0.45, 0.06, z], [-0.15, -0.08, z], [-0.15, 0.06, z], [0.15, -0.08, z], [0.15, 0.06, z], [0.45, -0.08, z]])
      for (const x of [-0.45, -0.15, 0.15]) poly([[x, 0.06, 0.225], [x, 0.06, -0.225]])
      edges(new CylinderGeometry(0.05, 0.06, 0.44, 6), [0.32, 0.1, 0])
      for (const x of [-0.27, -0.05, 0.17]) fill(new PlaneGeometry(0.12, 0.09), [x, -0.3, 0.226])
      const puffGeo = own(new CircleGeometry(1, 16))
      const puffs = [0, 1, 2].map(() => mark(at(new Mesh(puffGeo, smoke))))
      return (t) => {
        puffs.forEach((p, i) => {
          const u = (t / 2.4 + i / 3) % 1
          p.position.set(0.32 + u * 0.08, 0.34 + u * 0.3, 0)
          p.scale.setScalar((0.035 + 0.05 * u) * (1 - smooth(0.75, 1, u)))
        })
      }
    },
    // Validator: a rack of four slots whose lights run in sequence
    () => {
      edges(new BoxGeometry(0.46, 0.92, 0.4), [0, -0.04, 0])
      const ys = [0.26, 0.05, -0.16, -0.37]
      for (const y of ys) poly([[-0.2, y - 0.07, 0.201], [0.2, y - 0.07, 0.201]])
      const leds = ys.map((y) => fill(new PlaneGeometry(0.06, 0.06), [0.13, y, 0.202]))
      return (t) => {
        const on = Math.floor(t * 2.5) % leds.length
        leds.forEach((l, i) => { l.material = i === on ? accent : dim })
      }
    },
    // Bridge: an arch over a deck, a crumb crossing it
    () => {
      const arch: V[] = Array.from({ length: 25 }, (_, i) => {
        const a = Math.PI - (i / 24) * Math.PI
        return [Math.cos(a) * 0.42, -0.26 + Math.sin(a) * 0.42, 0]
      })
      poly(arch)
      poly([[-0.5, -0.12, 0], [0.5, -0.12, 0]])
      poly([[-0.5, -0.12, -0.14], [0.5, -0.12, -0.14]])
      for (const x of [-0.24, 0, 0.24]) poly([[x, -0.12, 0], [x, -0.26 + Math.sqrt(0.42 * 0.42 - x * x), 0]])
      for (const x of [-0.42, 0.42]) poly([[x, -0.26, 0], [x, -0.46, 0]])
      const crumb = fill(new SphereGeometry(0.045, 10, 8), [0, -0.08, 0.02])
      return (t) => {
        const u = (t / 2.6) % 1
        crumb.position.x = -0.46 + u * 0.92
        crumb.scale.setScalar(smooth(0, 0.08, u) * (1 - smooth(0.92, 1, u)))
      }
    },
    // Cookie Jar: an eight-sided jar with cookies inside and a lid that peeks open
    () => {
      edges(new CylinderGeometry(0.28, 0.3, 0.56, 8), [0, -0.2, 0])
      const lid = new Group()
      lid.position.set(0, 0.12, 0)
      into.add(lid)
      const back = into
      into = lid
      edges(new CylinderGeometry(0.22, 0.22, 0.07, 8))
      fill(new SphereGeometry(0.05, 10, 8), [0, 0.07, 0])
      into = back
      fill(new CircleGeometry(0.09, 20), [-0.08, -0.34, 0.05])
      fill(new CircleGeometry(0.08, 20), [0.1, -0.22, -0.04])
      return (t) => { lid.position.y = 0.12 + 0.08 * Math.pow(Math.max(0, Math.sin((t * TAU) / 4.5)), 8) }
    },
  ]

  const bakers: Baker[] = builders.map((build) => {
    const slot = new Group()
    const body = new Group()
    body.rotation.set(0.3, -0.45, 0)
    slot.add(body)
    group.add(slot)
    outlines = []
    accents = []
    into = body
    const animate = build(body)
    into = group
    return { slot, body, outlines, accents, animate, owned: -1, pop: 0, popV: 0, trail: null }
  })

  let w = 0
  let h = 0
  let first = true

  function paint(b: Baker) {
    const has = b.owned > 0
    for (const o of b.outlines) o.material = has ? solid : ghost
    for (const a of b.accents) a.visible = has
    if (b.trail) {
      b.trail.line.visible = has
      b.trail.crumb.visible = has
    }
  }

  function layout(nw: number, nh: number) {
    w = nw
    h = nh
    const flank = w >= FLANK_MIN
    // the cookie: its canvas is square, as tall as this one beside it, as wide as the gap above the shelf under it
    const size = flank ? h : Math.max(40, h - SHELF)
    const centre = new Vector3(0, flank ? 0 : h / 2 - size / 2, 0)
    const rim = (size / 2) * COOKIE_FILL * 0.96
    bakers.forEach((b, t) => {
      let x: number
      let y: number
      let s: number
      if (flank) {
        // alternate sides so the first bakers bought sit left and right of the cookie, top first
        const side = t % 2 ? 1 : -1
        const cellH = h / 4
        const sideW = w / 2 - size / 2
        s = Math.min(sideW * 0.62, cellH * 0.78)
        x = side * (size / 2 + sideW / 2)
        y = h / 2 - cellH * (Math.floor(t / 2) + 0.5)
        b.slot.scale.set(side < 0 ? s : -s, s, s)
      } else {
        const cellW = w / 4
        const cellH = SHELF / 2
        s = Math.min(cellW, cellH) * 0.78
        x = -w / 2 + cellW * ((t % 4) + 0.5)
        y = -h / 2 + SHELF - cellH * (Math.floor(t / 4) + 0.5)
        b.slot.scale.set(s, s, s)
      }
      b.slot.position.set(x, y, 0)

      // the trail runs from the baker's cookie-side edge to the rim, bowing a little; on the shelf only
      // the top row gets one, a bottom-row trail would cut through the baker above it
      if (b.trail) {
        group.remove(b.trail.line, b.trail.crumb)
        b.trail.line.geometry.dispose()
        b.trail = null
      }
      if (!flank && t >= 4) return
      const from = new Vector3(x, y, 0)
      const to = from.clone().sub(centre).normalize().multiplyScalar(rim).add(centre)
      const start = from.clone().lerp(to, (s * 0.55) / Math.max(1, from.distanceTo(to)))
      const bow = new Vector3(0, flank ? -14 : 10, 0)
      const curve = new CubicBezierCurve3(start, start.clone().lerp(to, 0.35).add(bow), start.clone().lerp(to, 0.7).add(bow), to)
      const line = new Line(new BufferGeometry().setFromPoints(curve.getPoints(24)), trailMat)
      line.computeLineDistances()
      const crumb = new Mesh(crumbGeo, accent)
      group.add(line, crumb)
      b.trail = { line, curve, crumb }
    })
    for (const b of bakers) paint(b)
  }

  return {
    group,
    setOwned(owned) {
      bakers.forEach((b, t) => {
        const n = owned[t] ?? 0
        if (n === b.owned) return
        if (!first && n > b.owned) {
          // a first unit arrives from small; another one gives a bounce
          b.pop = b.owned > 0 ? 0.16 : -0.55
          b.popV = 0
        }
        b.owned = n
        paint(b)
      })
      first = false
    },
    layout,
    update(dt, t, still) {
      if (!w) return
      bakers.forEach((b, i) => {
        // pop as a spring back to rest; still gets no motion at all
        if (still) b.pop = 0
        else {
          b.popV += (-300 * b.pop - 16 * b.popV) * dt
          b.pop += b.popV * dt
        }
        b.body.scale.setScalar(1 + b.pop)
        if (b.owned > 0) b.animate(still ? 0 : t)
        if (b.trail && b.owned > 0) {
          const u = still ? 0.5 : (t / 3.4 + i * 0.23) % 1
          b.trail.crumb.position.copy(b.trail.curve.getPointAt(u))
          b.trail.crumb.scale.setScalar(3 * smooth(0, 0.1, u) * (1 - smooth(0.9, 1, u)))
        }
      })
    },
    dispose() {
      for (const b of bakers) b.trail?.line.geometry.dispose()
      for (const d of trash) d.dispose()
    },
  }
}
