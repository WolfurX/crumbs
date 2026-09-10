import { WebGLRenderer } from 'three'

export interface View {
  renderer: WebGLRenderer
  /** Current drawing size in CSS pixels. */
  size(): [number, number]
  dispose(): void
}

/**
 * A transparent renderer sized to its host. The frame callback runs only while the host is on
 * screen and the tab is visible, so an idle scene costs nothing.
 */
export function createView(host: HTMLElement, canvas: HTMLCanvasElement, frame: (dt: number, t: number) => void): View {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  let w = 1
  let h = 1
  const resize = () => {
    const r = host.getBoundingClientRect()
    w = Math.max(1, Math.round(r.width))
    h = Math.max(1, Math.round(r.height))
    renderer.setSize(w, h, false)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(host)

  let onScreen = true
  let raf = 0
  let last = 0
  const loop = (now: number) => {
    raf = 0
    if (!onScreen || document.hidden) return
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
    last = now
    frame(dt, now / 1000)
    raf = requestAnimationFrame(loop)
  }
  const start = () => {
    if (!raf && onScreen && !document.hidden) {
      last = 0
      raf = requestAnimationFrame(loop)
    }
  }
  const io = new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting
    start()
  })
  io.observe(host)
  document.addEventListener('visibilitychange', start)
  start()

  return {
    renderer,
    size: () => [w, h],
    dispose() {
      cancelAnimationFrame(raf)
      raf = -1 // never restart
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', start)
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}
