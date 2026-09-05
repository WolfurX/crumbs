import type { Batch } from '../lib/txs'
import { txUrl } from '../lib/chain'
import { shortAddr } from '../lib/format'

const LABEL: Record<Batch['status'], string> = {
  pending: 'Ready',
  signing: 'Waiting for signature',
  sending: 'Sending',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  failed: 'Failed',
  expired: 'Expired',
}

export function BatchList({ batches, unit }: { batches: Batch[]; unit: string }) {
  return (
    <div className="batches">
      {batches.map((b) => {
        const live = b.status === 'signing' || b.status === 'sending' || b.status === 'confirming'
        return (
          <div className="batch" key={b.id}>
            <span className="muted num">{b.id}</span>
            <span>
              <span className={`dot${b.status === 'confirmed' ? ' ok' : b.status === 'failed' || b.status === 'expired' ? ' bad' : live ? ' live' : ''}`} />
              {LABEL[b.status]}
              <span className="muted"> · {b.items.length} {unit}</span>
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
