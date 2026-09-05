/** Small feedback helpers for the clicker: a click sound and the mute preference. */
let ctx: AudioContext | null = null
const KEY = 'crumbs.muted'

export function isMuted(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
export function setMuted(v: boolean) {
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* fine */ }
}

/** A short, soft tick. Created on first use so it runs inside a user gesture. */
export function tick(kind: 'click' | 'buy' | 'claim' = 'click') {
  if (isMuted()) return
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = kind === 'click' ? 'triangle' : 'sine'
    const f0 = kind === 'click' ? 720 : kind === 'buy' ? 520 : 880
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.exponentialRampToValueAtTime(kind === 'click' ? 420 : f0 * 1.5, t + (kind === 'click' ? 0.06 : 0.18))
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(kind === 'click' ? 0.06 : 0.08, t + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'click' ? 0.09 : 0.25))
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.3)
  } catch { /* no audio, no problem */ }
}
