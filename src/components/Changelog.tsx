import { CHANGELOG } from '../changelog'
import { IconArrowRight } from '../icons'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** The changelog as its own page (`#changelog`): every release, newest first, and a way back to the tool you were on. */
export function Changelog({ backTo }: { backTo: string }) {
  return (
    <section className="page changelog" aria-labelledby="changelog-title">
      <a className="small back" href={`#${backTo}`}>Back to Crumbs</a>
      <div className="row between" style={{ marginTop: '0.6rem' }}>
        <h1 id="changelog-title">What changed</h1>
        <a className="small" href="https://github.com/WolfurX/crumbs/commits/main" target="_blank" rel="noreferrer">Every commit <IconArrowRight /></a>
      </div>
      <p className="lead">Every release that reached production, newest first.</p>
      <ul className="changelog-list">
        {CHANGELOG.map((e) => (
          <li key={e.date}>
            <time dateTime={e.date}>{fmtDate(e.date)}</time>
            <div>
              <b>{e.title}</b>
              <p className="ink2">{e.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
