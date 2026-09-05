import { useEffect, useSyncExternalStore } from 'react'
import { IconCircleCheck } from '../icons'

interface ToastItem {
  id: number
  text: string
  leaving?: boolean
}

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Fire-and-forget confirmation line at the bottom of the screen. */
export function toast(text: string) {
  const id = nextId++
  items = [...items, { id, text }]
  emit()
  setTimeout(() => {
    items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    emit()
    setTimeout(() => {
      items = items.filter((t) => t.id !== id)
      emit()
    }, 220)
  }, 3200)
}

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => items,
  )
  useEffect(() => () => listeners.clear(), [])
  if (!list.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast${t.leaving ? ' leaving' : ''}`}>
          <IconCircleCheck /> {t.text}
        </div>
      ))}
    </div>
  )
}
