import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CubicBezierCurve3,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { ACCENT, HAIRLINE, buildCookie, buildHalo, lights } from './cookie'

const MUTED = 0x877f73
const TAU = Math.PI * 2

// hero.svg is a 480 x 270 drawing; one world unit is 100 of its pixels, origin at its centre
const P = (x: number, y: number, z = 0) => new Vector3((x - 240) / 100, (135 - y) / 100, z)

export interface Hero {
  group: Group
  /** The cookie group, for the pointer tilt. */
  cookie: Group
  update(dt: number, t: number, still: boolean): void
  dispose(): void
}

/** The hero drawing as a scene: cookie under a lens, crumbs travelling to holders, a parachute over a wallet, a broom. */
export function buildHero(): Hero {
  const group = new Group()
  const trash: { dispose(): void }[] = []
  const hair = new LineBasicMaterial({ color: HAIRLINE })
  const accentMat = new MeshBasicMaterial({ color: ACCENT })
  const mutedMat = new MeshBasicMaterial({ color: MUTED })
  trash.push(hair, accentMat, mutedMat)

  const line = (pts: Vector3[], closed = false) => {
    const geo = new BufferGeometry().setFromPoints(pts)
    trash.push(geo)
    const l = closed ? new LineLoop(geo, hair) : new Line(geo, hair)
    group.add(l)
    return l
  }
  const circle = (n: number, r: number) => Array.from({ length: n }, (_, i) => new Vector3(Math.cos((i / n) * TAU) * r, Math.sin((i / n) * TAU) * r, 0))
  /** An accent stroke with real weight: a thin cylinder between two points. */
  const stroke = (a: Vector3, b: Vector3, radius = 0.01) => {
    const d = b.clone().sub(a)
    const geo = new CylinderGeometry(radius, radius, d.length(), 6)
    trash.push(geo)
    const m = new Mesh(geo, accentMat)
    m.position.copy(a).add(b).multiplyScalar(0.5)
    m.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.normalize()))
    group.add(m)
  }

  // lens and cookie
  const lens = buildHalo(0.94, 0.03, 0.08)
  lens.line.position.copy(P(118, 138, -0.1))
  group.add(lens.line)
  trash.push(lens)
  const ck = buildCookie(0.015)
  ck.group.scale.setScalar(0.66)
  ck.group.position.copy(P(118, 138))
  group.add(ck.group)
  trash.push(ck)

  // trails, crumbs riding them
  const curves = [
    new CubicBezierCurve3(P(188, 112), P(240, 92), P(280, 70), P(340, 58)),
    new CubicBezierCurve3(P(190, 140), P(250, 140), P(290, 150), P(336, 172)),
    new CubicBezierCurve3(P(182, 170), P(230, 196), P(270, 224), P(328, 236)),
  ]
  for (const c of curves) line(c.getPoints(40))
  const crumbGeo = new SphereGeometry(1, 10, 8)
  trash.push(crumbGeo)
  const riders: { mesh: Mesh; curve: CubicBezierCurve3; phase: number; size: number }[] = []
  const phases = [[0, 0.33, 0.66], [0.15, 0.48, 0.81], [0.05, 0.3, 0.55, 0.8]]
  curves.forEach((curve, i) => {
    for (const phase of phases[i]) {
      const mesh = new Mesh(crumbGeo, accentMat)
      group.add(mesh)
      riders.push({ mesh, curve, phase, size: 0.02 })
    }
  })
  const loose = [P(60, 232, 0.05), P(150, 34, 0.05)].map((p, i) => {
    const m = new Mesh(crumbGeo, accentMat)
    m.scale.setScalar(0.021)
    m.position.copy(p)
    m.userData.delay = i * 1.9
    group.add(m)
    return m
  })

  // holders: hairline ring, muted disc, sitting a little behind the drawing plane
  const discGeo = new CircleGeometry(1, 24)
  trash.push(discGeo)
  for (const [x, y, r] of [[360, 44, 5], [398, 66, 4], [432, 40, 6], [436, 86, 4], [394, 108, 3]]) {
    const at = P(x, y, -0.12)
    line(circle(40, (r + 6) / 100).map((v) => v.add(at)), true)
    const d = new Mesh(discGeo, mutedMat)
    d.scale.setScalar(r / 100)
    d.position.copy(at)
    group.add(d)
  }

  // parachute: a wireframe dome with an accent front rim, lines to an accent payload
  const chute = new Group()
  chute.position.copy(P(392, 100, 0.15))
  const domeGeo = new SphereGeometry(0.28, 8, 3, 0, TAU, 0, Math.PI / 2)
  const domeEdges = new EdgesGeometry(domeGeo, 1)
  trash.push(domeGeo, domeEdges)
  const dome = new LineSegments(domeEdges, hair)
  dome.position.y = -0.2
  chute.add(dome)
  const rimGeo = new TorusGeometry(0.28, 0.01, 6, 48, Math.PI)
  trash.push(rimGeo)
  const rim = new Mesh(rimGeo, accentMat)
  rim.position.y = -0.2
  chute.add(rim)
  const lineGeo = new BufferGeometry().setFromPoints([
    new Vector3(-0.28, -0.2, 0), new Vector3(0, -0.52, 0), new Vector3(0.28, -0.2, 0),
    new Vector3(-0.1, -0.2, 0), new Vector3(0, -0.52, 0), new Vector3(0.1, -0.2, 0),
  ])
  trash.push(lineGeo)
  chute.add(new Line(lineGeo, hair))
  const payGeo = new PlaneGeometry(0.1, 0.1)
  trash.push(payGeo)
  const pay = new Mesh(payGeo, accentMat)
  pay.position.y = -0.57
  chute.add(pay)
  group.add(chute)

  // wallet: an outlined box with the card slit and a clasp
  const wallet = new Group()
  wallet.position.copy(P(392, 192))
  const boxGeo = new BoxGeometry(0.52, 0.32, 0.14)
  const boxEdges = new EdgesGeometry(boxGeo)
  trash.push(boxGeo, boxEdges)
  wallet.add(new LineSegments(boxEdges, hair))
  const slitGeo = new BufferGeometry().setFromPoints([new Vector3(-0.26, 0.05, 0.071), new Vector3(0.26, 0.05, 0.071)])
  trash.push(slitGeo)
  wallet.add(new Line(slitGeo, hair))
  const clasp = new Mesh(discGeo, mutedMat)
  clasp.scale.setScalar(0.025)
  clasp.position.set(0.15, -0.06, 0.072)
  wallet.add(clasp)
  group.add(wallet)

  // broom and dustpan, closest to the viewer
  stroke(P(440, 190, 0.2), P(392, 246, 0.2))
  const head = [P(392, 246, 0.2), P(376, 238, 0.2), P(366, 262, 0.2), P(400, 264, 0.2)]
  head.forEach((p, i) => stroke(p, head[(i + 1) % head.length], 0.0075))
  line([P(312, 254, 0.1), P(346, 254, 0.1), P(346, 264, 0.1), P(306, 264, 0.1), P(301, 259, 0.1), P(301, 258, 0.1), P(305, 254, 0.1)], true)

  group.add(...lights())

  const smooth = (a: number, b: number, x: number) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)
  }
  return {
    group,
    cookie: ck.group,
    update(_dt, t, still) {
      const tt = still ? 0 : t
      for (const r of riders) {
        const u = (tt / 7 + r.phase) % 1
        r.mesh.position.copy(r.curve.getPointAt(u)).setZ(0.05)
        r.mesh.scale.setScalar(r.size * smooth(0, 0.08, u) * (1 - smooth(0.92, 1, u)))
      }
      for (const m of loose) m.position.y = P(0, 0).y + (m === loose[0] ? P(60, 232).y : P(150, 34).y) + (still ? 0 : Math.sin((tt / 5.5 + m.userData.delay) * TAU) * 0.03)
      chute.position.y = P(392, 100).y + (still ? 0 : Math.sin((tt / 5.5 + 0.8) * TAU) * 0.03)
    },
    dispose() {
      for (const d of trash) d.dispose()
    },
  }
}
