import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CALLBACK_URL = 'contextcake://auth/callback'
const OAUTH_STATE_KEY = 'contextcake.oauth.state'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/**
 * Supabase needs one storage adapter for both the PKCE verifier and the
 * resulting session. Encrypt the complete adapter payload with Electron's
 * safeStorage so neither value ever lands on disk as plaintext.
 */
export function createEncryptedStorage({ configDir, safeStorage }) {
  const file = path.join(configDir, 'session.enc')
  const memory = new Map()
  let writesSuspended = false

  const encryptionAvailable = () => {
    try { return safeStorage?.isEncryptionAvailable() === true } catch { return false }
  }

  const readMap = () => {
    if (!encryptionAvailable()) return Object.fromEntries(memory)
    try {
      const encrypted = fs.readFileSync(file)
      const plaintext = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(plaintext)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      // Missing, locked, or stale Keychain material is a signed-out state.
      return {}
    }
  }

  const writeMap = (values) => {
    if (!encryptionAvailable()) {
      memory.clear()
      for (const [key, value] of Object.entries(values)) memory.set(key, value)
      return
    }
    fs.mkdirSync(configDir, { recursive: true })
    const encrypted = safeStorage.encryptString(JSON.stringify(values))
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 })
    fs.renameSync(temporary, file)
    try { fs.chmodSync(file, 0o600) } catch { /* best effort on non-POSIX test hosts */ }
  }

  const clear = () => {
    memory.clear()
    try { fs.rmSync(file) } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  return {
    file,
    getItem(key) {
      const value = readMap()[key]
      return typeof value === 'string' ? value : null
    },
    setItem(key, value) {
      if (writesSuspended) return
      writeMap({ ...readMap(), [key]: value })
    },
    removeItem(key) {
      const next = readMap()
      delete next[key]
      if (Object.keys(next).length === 0) clear()
      else writeMap(next)
    },
    clear,
    suspendWrites() {
      writesSuspended = true
      clear()
    },
    resumeWrites() {
      writesSuspended = false
    },
  }
}

function publicState(available, session, notice = '') {
  if (!session?.user) return { available, signedIn: false, ...(notice ? { notice } : {}) }
  return {
    available,
    signedIn: true,
    ...(session.user.email ? { email: session.user.email } : {}),
  }
}

/** Main-process-only Supabase OAuth broker. No session-returning method is IPC-exposed. */
export function createAuthManager({
  supabaseUrl,
  supabaseKey,
  configDir,
  safeStorage,
  openExternal,
  createClientImpl = createClient,
  fetchImpl = globalThis.fetch,
  bootstrapTimeoutMs = 1500,
  signOutTimeoutMs = 1500,
  refreshTimeoutMs = 10_000,
  refreshLeewayMs = 60_000,
} = {}) {
  const events = new EventEmitter()
  const storage = createEncryptedStorage({ configDir, safeStorage })
  const available = Boolean(supabaseUrl && supabaseKey)
  let activeRefresh = null
  let refreshDrain = Promise.resolve()
  const projectOrigin = available ? new URL(supabaseUrl).origin : ''
  const fetchWithRefreshAbort = (input, init = {}) => {
    const controller = activeRefresh?.controller
    if (!controller) return fetchImpl(input, init)
    try {
      const rawUrl = typeof input === 'string' || input instanceof URL ? input : input.url
      const url = new URL(rawUrl)
      const refreshRequest = url.origin === projectOrigin
        && url.pathname.endsWith('/auth/v1/token')
        && url.searchParams.get('grant_type') === 'refresh_token'
      if (refreshRequest) {
        const signal = init.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        return fetchImpl(input, { ...init, signal })
      }
    } catch { /* delegate malformed or non-URL inputs unchanged */ }
    return fetchImpl(input, init)
  }
  const client = available
    ? createClientImpl(supabaseUrl, supabaseKey, {
        global: { fetch: fetchWithRefreshAbort },
        auth: {
          flowType: 'pkce',
          persistSession: true,
          // Electron has no reliable browser-visibility lifecycle. Refresh on
          // our own bounded timer so an auth outage can never stall startup.
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storage,
        },
      })
    : null

  let currentSession = null
  let subscription = null
  let refreshTimer = null
  let notice = ''

  const emitState = () => events.emit('session-changed', publicState(available, currentSession, notice))

  const withTimeout = (promise, timeoutMs, message, onTimeout) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error(message))
    }, timeoutMs)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })

  function clearRefreshTimer() {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  function scheduleRefresh(session) {
    clearRefreshTimer()
    if (!client || !session?.expires_at) return
    const delay = Math.max(10, (session.expires_at * 1000) - Date.now() - refreshLeewayMs)
    refreshTimer = setTimeout(async () => {
      refreshTimer = null
      const attempt = { controller: new AbortController(), stale: false }
      activeRefresh = attempt
      const refreshRequest = Promise.resolve().then(() => client.auth.refreshSession())
      // Keep session writes fenced until a stale refresh drains. New OAuth
      // attempts wait for this promise so an old token response can never
      // overwrite a newer PKCE verifier or session.
      const drain = refreshRequest.catch(() => {}).finally(() => {
        if (attempt.stale) storage.clear()
        if (activeRefresh === attempt) activeRefresh = null
        storage.resumeWrites()
      })
      refreshDrain = drain
      try {
        const { data, error } = await withTimeout(
          refreshRequest,
          refreshTimeoutMs,
          'Session refresh timed out.',
          () => {
            attempt.stale = true
            storage.suspendWrites()
            attempt.controller.abort()
          },
        )
        if (error) throw error
        currentSession = data?.session ?? null
        if (!currentSession) throw new Error('Session refresh returned no session.')
        notice = ''
        emitState()
        scheduleRefresh(currentSession)
      } catch {
        currentSession = null
        notice = 'Your session expired. Sign in again to resume settings sync.'
        storage.clear()
        emitState()
      }
    }, delay)
    refreshTimer.unref?.()
  }

  async function initialize() {
    if (!client) return publicState(false, null)
    try {
      const result = client.auth.onAuthStateChange((event, session) => {
        // Manual refreshes are committed from refreshSession's returned value
        // above. Ignoring this duplicate event also prevents a timed-out
        // request from restoring currentSession after its deadline.
        if (event === 'TOKEN_REFRESHED') return
        currentSession = session ?? null
        notice = ''
        scheduleRefresh(currentSession)
        emitState()
      })
      subscription = result?.data?.subscription ?? null
      const { data, error } = await withTimeout(
        client.auth.getSession(),
        bootstrapTimeoutMs,
        'Session restore timed out.',
      )
      if (error) throw error
      currentSession = data?.session ?? null
      scheduleRefresh(currentSession)
    } catch {
      // Auth outages and unreadable old sessions never block the local app.
      currentSession = null
    }
    return publicState(true, currentSession, notice)
  }

  async function signIn() {
    if (!client) throw new Error('Account sign-in is not configured in this build.')
    await refreshDrain

    const pending = (() => {
      try { return JSON.parse(storage.getItem(OAUTH_STATE_KEY)) } catch { return null }
    })()
    if (pending?.value && Number.isFinite(pending.createdAt) && Date.now() - pending.createdAt < OAUTH_STATE_TTL_MS) {
      throw new Error('A sign-in is already in progress.')
    }
    const state = crypto.randomBytes(32).toString('base64url')
    storage.setItem(OAUTH_STATE_KEY, JSON.stringify({ value: state, createdAt: Date.now() }))
    const redirectTo = `${CALLBACK_URL}?state=${encodeURIComponent(state)}`
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo, skipBrowserRedirect: true },
      })
      if (error) throw error
      if (!data?.url) throw new Error('The authentication provider did not return a sign-in URL.')
      const authUrl = new URL(data.url)
      const projectOrigin = new URL(supabaseUrl).origin
      if (authUrl.protocol !== 'https:' || authUrl.origin !== projectOrigin) {
        throw new Error('The authentication provider returned an invalid sign-in URL.')
      }
      await openExternal(authUrl.toString())
      return { opened: true }
    } catch (err) {
      storage.removeItem(OAUTH_STATE_KEY)
      throw err
    }
  }

  async function handleDeepLink(rawUrl) {
    if (!client) return false
    let url
    try { url = new URL(rawUrl) } catch { return false }
    if (url.protocol !== 'contextcake:' || url.hostname !== 'auth' || url.pathname !== '/callback') return false

    let pending
    try { pending = JSON.parse(storage.getItem(OAUTH_STATE_KEY)) } catch { pending = null }
    const expectedState = pending?.value
    const receivedState = url.searchParams.get('state')
    if (!expectedState || !Number.isFinite(pending.createdAt)) {
      storage.removeItem(OAUTH_STATE_KEY)
      throw new Error('Sign-in callback state is missing or expired. Please try again.')
    }
    if (Date.now() - pending.createdAt >= OAUTH_STATE_TTL_MS) {
      storage.removeItem(OAUTH_STATE_KEY)
      throw new Error('Sign-in callback state is missing or expired. Please try again.')
    }
    if (!receivedState) {
      throw new Error('Sign-in callback state is missing or expired. Please try again.')
    }
    const expected = Buffer.from(expectedState)
    const received = Buffer.from(receivedState)
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      throw new Error('Sign-in callback state did not match. Please try again.')
    }
    const code = url.searchParams.get('code')
    if (!code) {
      storage.removeItem(OAUTH_STATE_KEY)
      throw new Error('Sign-in did not return an authorization code. Please try again.')
    }

    storage.removeItem(OAUTH_STATE_KEY)
    const { data, error } = await client.auth.exchangeCodeForSession(code)
    if (error) throw error
    currentSession = data?.session ?? null
    if (!currentSession) throw new Error('Sign-in completed without a session. Please try again.')
    notice = ''
    scheduleRefresh(currentSession)
    emitState()
    return true
  }

  async function getSession() {
    return currentSession
  }

  function cancelSignIn() {
    storage.removeItem(OAUTH_STATE_KEY)
    return publicState(available, currentSession, notice)
  }

  async function signOut() {
    if (activeRefresh) {
      activeRefresh.stale = true
      storage.suspendWrites()
      activeRefresh.controller.abort()
    }
    try {
      if (client) {
        await withTimeout(client.auth.signOut({ scope: 'local' }), signOutTimeoutMs, 'Sign-out timed out.').catch(() => {})
      }
    } finally {
      clearRefreshTimer()
      currentSession = null
      notice = ''
      storage.clear()
      emitState()
    }
  }

  async function deleteAccount() {
    if (!client || !currentSession?.user) throw new Error('You are not signed in.')
    const { error } = await client.rpc('delete_own_account')
    if (error) throw error
    await signOut()
  }

  function close() {
    clearRefreshTimer()
    if (activeRefresh) {
      activeRefresh.stale = true
      storage.suspendWrites()
      activeRefresh.controller.abort()
    }
    subscription?.unsubscribe?.()
    subscription = null
    events.removeAllListeners()
  }

  return {
    initialize,
    signInWithGitHub: signIn,
    cancelSignIn,
    signOut,
    getSession,
    getUserId: () => currentSession?.user?.id ?? null,
    getState: () => publicState(available, currentSession, notice),
    deleteAccount,
    handleDeepLink,
    on: events.on.bind(events),
    off: events.off.bind(events),
    getClient: () => client,
    close,
  }
}
