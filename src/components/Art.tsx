// Line-art illustrations for the empty states. One stroke weight, the accent for the subject, the
// hairline color for context. The crumbs drift slowly (transform only); still under reduced motion.
const A = 'var(--accent)'
const L = 'var(--line-strong)'
const M = 'var(--muted)'

function Crumb({ x, y, r = 2.2, delay = 0 }: { x: number; y: number; r?: number; delay?: number }) {
  return <circle className="art-crumb" cx={x} cy={y} r={r} fill={A} style={{ animationDelay: `${delay}s` }} />
}

function Cookie({ x, y, r }: { x: number; y: number; r: number }) {
  const chips = [
    [-0.35, -0.3, 0.14],
    [0.3, -0.42, 0.11],
    [0.42, 0.22, 0.15],
    [-0.1, 0.45, 0.12],
    [-0.5, 0.2, 0.1],
    [0.05, -0.02, 0.1],
  ]
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="none" stroke={A} strokeWidth={1.75} />
      {chips.map(([dx, dy, dr], i) => (
        <circle key={i} cx={x + dx * r} cy={y + dy * r} r={dr * r} fill={A} opacity={0.9} />
      ))}
    </g>
  )
}

/** A cookie under a lens, its holders fanned out to the right. */
export function ArtSnapshot() {
  const holders = [
    [232, 38, 5],
    [262, 62, 4],
    [278, 96, 6],
    [258, 128, 4],
    [226, 118, 3],
  ]
  return (
    <svg className="art" viewBox="0 0 320 160" role="img" aria-label="A cookie and its holders">
      <circle cx={104} cy={82} r={62} fill="none" stroke={L} strokeWidth={1.25} strokeDasharray="3 7" />
      <Cookie x={104} y={82} r={40} />
      <path d="M150 62 L212 44 M150 82 L226 96 M150 96 L236 126" stroke={L} strokeWidth={1.25} fill="none" />
      {holders.map(([cx, cy, r], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r={r + 5} fill="none" stroke={L} strokeWidth={1.25} />
          <circle cx={cx} cy={cy} r={r} fill={M} />
        </g>
      ))}
      <Crumb x={62} y={132} delay={0} />
      <Crumb x={160} y={30} r={1.8} delay={1.4} />
      <Crumb x={196} y={142} r={1.6} delay={2.6} />
    </svg>
  )
}

/** Three parachutes carrying crumbs down to three wallets. */
export function ArtAirdrop() {
  const drops = [
    [70, 26, 0],
    [160, 14, 1.2],
    [250, 34, 2.4],
  ]
  return (
    <svg className="art" viewBox="0 0 320 160" role="img" aria-label="Parachutes dropping crumbs into wallets">
      {drops.map(([x, y, d], i) => (
        <g key={i} className="art-float" style={{ animationDelay: `${d}s` }}>
          <path d={`M${x - 26} ${y + 18} A26 26 0 0 1 ${x + 26} ${y + 18} Z`} fill="none" stroke={A} strokeWidth={1.75} />
          <path d={`M${x - 26} ${y + 18} L${x} ${y + 48} L${x + 26} ${y + 18} M${x - 9} ${y + 18} L${x} ${y + 48} L${x + 9} ${y + 18}`} stroke={L} strokeWidth={1.25} fill="none" />
          <rect x={x - 5} y={y + 48} width={10} height={10} rx={2} fill={A} />
        </g>
      ))}
      {[70, 160, 250].map((x, i) => (
        <g key={i}>
          <rect x={x - 24} y={116} width={48} height={30} rx={5} fill="none" stroke={L} strokeWidth={1.25} />
          <path d={`M${x - 24} 126 H${x + 24}`} stroke={L} strokeWidth={1.25} />
          <circle cx={x + 14} cy={136} r={2.5} fill={M} />
        </g>
      ))}
      <Crumb x={116} y={96} r={1.8} delay={0.6} />
      <Crumb x={206} y={86} r={1.6} delay={1.9} />
    </svg>
  )
}

/** A broom sweeping crumbs into a dustpan. */
export function ArtCleanup() {
  return (
    <svg className="art" viewBox="0 0 320 160" role="img" aria-label="A broom sweeping crumbs into a dustpan">
      <path d="M212 18 L140 108" stroke={A} strokeWidth={2} />
      <path d="M140 108 L118 96 L104 136 L152 140 Z" fill="none" stroke={A} strokeWidth={1.75} />
      <path d="M116 112 L110 128 M126 116 L120 132 M136 120 L130 136" stroke={L} strokeWidth={1.25} />
      <path d="M52 132 H98 V144 H44 A6 6 0 0 1 38 138 V136 A4 4 0 0 1 42 132 Z" fill="none" stroke={L} strokeWidth={1.25} />
      <path d="M98 132 V144" stroke={L} strokeWidth={1.25} />
      <Crumb x={72} y={126} delay={0} />
      <Crumb x={84} y={122} r={1.8} delay={1} />
      <Crumb x={60} y={124} r={1.6} delay={2} />
      <path d="M248 78 l3 -9 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 z" fill="none" stroke={L} strokeWidth={1.25} />
      <path d="M270 40 l2 -5 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 z" fill="none" stroke={L} strokeWidth={1.25} />
    </svg>
  )
}
