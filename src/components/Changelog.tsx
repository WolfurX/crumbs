import { useState } from 'react'
import { CHANGELOG } from '../changelog'
import { IconChevronDown } from '../icons'

const SHOWN = 3
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** What shipped, newest first. The latest few by default, the whole list on request. */
export function Changelog() {
  const [all, setAll] = useState(false)
  const entries = all ? CHANGELOG : CHANGELOG.slice(0, SHOWN)
  return (
    <section className="roadmap changelog" aria-labelledby="changelog-title">
      <div className="row between">
        <h2 id="changelog-title">What changed</h2>
        <a className="small" href="https://github.com/WolfurX/crumbs/commits/main" target="_blank" rel="noreferrer">Every commit</a>
      </div>
      <ul className="changelog-list">
        {entries.map((e) => (
          <li key={e.date}>
            <time dateTime={e.date}>{fmtDate(e.date)}</time>
            <div>
              <b>{e.title}</b>
              <p className="ink2 small">{e.text}</p>
            </div>
          </li>
        ))}
      </ul>
      {CHANGELOG.length > SHOWN && (
        <button className="btn quiet" style={{ marginTop: '0.4rem' }} onClick={() => setAll((a) => !a)}>
          <IconChevronDown style={{ transform: all ? 'rotate(180deg)' : undefined }} /> {all ? 'Fewer' : `All ${CHANGELOG.length} entries`}
        </button>
      )}
    </section>
  )
}
