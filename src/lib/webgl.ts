/** Capability probes for the 3D scenes. Kept out of the three.js chunk so a page without WebGL never downloads it. */
let ok: boolean | null = null

export function webglOk(): boolean {
  if (ok !== null) return ok
  try {
    const c = document.createElement('canvas')
    ok = !!(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    ok = false
  }
  return ok
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
