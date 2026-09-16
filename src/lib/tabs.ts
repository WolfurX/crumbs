import { createContext, useContext } from 'react'
import { offerFromHash } from '../swap/offer'

export type Tab = 'snapshot' | 'airdrop' | 'cleanup' | 'swap' | 'clicker' | 'crumb' | 'mint'

export const TAB_IDS: Tab[] = ['snapshot', 'airdrop', 'cleanup', 'swap', 'clicker', 'crumb', 'mint']

/** The tab named in the URL hash: `#airdrop`, or `#swap=<offer>` for an offer link. Null when the hash names nothing. */
export function tabFromHash(hash = location.hash): Tab | null {
  if (offerFromHash(hash)) return 'swap'
  const id = hash.replace(/^#/, '')
  return (TAB_IDS as string[]).includes(id) ? (id as Tab) : null
}

/** Pages that replace the tool view: only the changelog for now. */
export type Page = 'changelog'
export function pageFromHash(hash = location.hash): Page | null {
  return hash === '#changelog' ? 'changelog' : null
}

/** Push the tab into the hash so reload, back and links land on it. An offer link on the swap tab is left alone. */
export function setHashTab(tab: Tab) {
  if (tabFromHash() === tab) return
  location.hash = tab
}

/** True while the surrounding tab is the one on screen. Tabs stay mounted once opened, so pollers gate on this. */
export const TabActiveContext = createContext(true)
export const useTabActive = () => useContext(TabActiveContext)
