import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

type Mode = 'dark' | 'light'
const KEY = 'cc-theme'

/** Read the persisted choice, defaulting to the dark control plane. */
export function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* ignore */ }
  return 'dark'
}

/** Apply before React mounts so there's no theme flash. */
export function applyMode(mode: Mode) {
  document.documentElement.dataset.theme = mode
}

interface ThemeCtx { mode: Mode; toggle: () => void }
const Ctx = createContext<ThemeCtx | null>(null)

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const mounted = useRef(false)
  const applyingRemote = useRef(false)
  const modeRef = useRef(mode)

  useEffect(() => {
    applyMode(mode)
    modeRef.current = mode
    try { localStorage.setItem(KEY, mode) } catch { /* ignore */ }
    if (!mounted.current) {
      mounted.current = true
    } else if (applyingRemote.current) {
      applyingRemote.current = false
    } else {
      // Main persists locally first, then uploads when signed in. A rejected
      // or offline sync never rolls back the local theme choice.
      window.__CC_AUTH?.syncSettings({ theme: mode }).catch(() => {})
    }
  }, [mode])

  useEffect(() => {
    const bridge = window.__CC_AUTH
    if (!bridge) return
    bridge.bootstrapTheme(mode).then((incoming) => {
      if (incoming !== modeRef.current) {
        applyingRemote.current = true
        setMode(incoming)
      }
    }).catch(() => {})
    return bridge.onSettingsPulled((settings) => {
      const incoming = settings.theme
      if ((incoming === 'light' || incoming === 'dark') && incoming !== modeRef.current) {
        applyingRemote.current = true
        setMode(incoming)
      }
    })
  }, [])

  const toggle = useCallback(() => setMode((m) => (m === 'dark' ? 'light' : 'dark')), [])

  return <Ctx.Provider value={{ mode, toggle }}>{children}</Ctx.Provider>
}

export function useThemeMode(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider')
  return ctx
}
