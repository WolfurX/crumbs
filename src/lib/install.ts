import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** The browser's install prompt, when it offers one and the app is not already installed. */
export function useInstallPrompt() {
  const [ev, setEv] = useState<BeforeInstallPromptEvent | null>(null)
  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setEv(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setEv(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  return ev
    ? async () => {
        await ev.prompt()
        const { outcome } = await ev.userChoice
        if (outcome === 'accepted') setEv(null)
      }
    : null
}
