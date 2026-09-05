import type { Batch } from '../lib/txs'
import { txUrl } from '../lib/chain'
import { shortAddr } from '../lib/format'
import { IconLoader2 } from '../icons'

const LABEL: Record<Batch['status'], string> = {
  pending: 'Ready',
  signing: 'Waiting for signature',
  sending: 'Sending',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  failed: 'Failed',
  expired: 'Expired',
}

function Tick() {
  return (
    <svg className="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5l9 -10" />
    </svg>
  )
}

export function BatchList({ batches, unit }: { batches: Batch[]; unit: string }) {
  return (
    <div className="batches">
      {batches.map((b) => {
        const live = b.status === 'signing' || b.status === 'sending' || b.status === 'confirming'
        const bad = b.status === 'failed' || b.status === 'expired'
        return (
          <div className="batch" key={b.id}>
            <span className="muted num">{b.id}</span>
            <span>
              {b.status === 'confirmed' ? <Tick /> : live ? <IconLoader2 className="spin" style={{ marginRight: '0.45rem', verticalAlign: '-2px', color: 'var(--ink-2)' }} /> : <span className={`dot${bad ? ' bad' : ''}`} />}
              {LABEL[b.status]}
              <span className="muted"> · {b.items.length} {b.items.length === 1 ? unit.replace(/s$/, '') : unit}</span>
              {b.error && <div className="err small">{b.error}</div>}
            </span>
            <span className="right">
              {b.signature && (
                <a className="mono small" href={txUrl(b.signature)} target="_blank" rel="noreferrer">
                  {shortAddr(b.signature, 6, 6)}
                </a>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
