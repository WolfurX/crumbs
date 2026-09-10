import { addressUrl } from '../lib/chain'
import { shortAddr } from '../lib/format'

/** A wallet as an explorer link: its primary .cook name when it has one, the short address otherwise. */
export function Addr({ addr, name, head = 6, tail = 6 }: { addr: string; name?: string; head?: number; tail?: number }) {
  return (
    <a className={name ? 'name' : 'mono'} href={addressUrl(addr)} target="_blank" rel="noreferrer" title={addr}>
      {name ?? shortAddr(addr, head, tail)}
    </a>
  )
}
