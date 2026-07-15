import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const SYNC_FIELDS = ['theme', 'updateCheck', 'activeProfile', 'profiles', 'sources']
const SCRUBBED = new Set(['execution', 'path', 'secret'])
const SECRET_KEY = /(?:^|_)(?:password|passwd|secret|token|api_?key|authorization|cookie|credential)(?:$|_)/i
const CONTEXT_KEY = /^(?:content|contents|body|document|documents|knowledge|markdown|payload|raw|resolved|sections|text)$/i
const CREDENTIAL_VALUE = /(?:^Bearer\s+|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b)/
const SECRET_ASSIGNMENT = /(?:^|[\s?&-])(?:access[_-]?token|api[_-]?key|secret|password|credential|authorization)\s*=/i
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_SYNC_JSON = 1_000_000
const SOURCE_KEYS = new Set([
  'args', 'cache', 'command', 'credential', 'kind', 'keychain', 'level', 'name',
  'origin', 'path', 'ref', 'repo', 'source', 'subdir', 'tokenEnv',
])
const CACHE_KEYS = new Set(['dir', 'ttlSeconds'])
const PROFILE_KEYS = new Set(['active', 'id', 'label', 'name', 'preferences', 'sources'])
const MANIFEST_PROFILE_KEYS = new Set(['label', 'layers', 'preferences'])
const PROFILE_PREFERENCE_KEYS = new Set(['theme'])

function scrubMarker(kind) {
  return { __scrubbed: kind }
}

function isMarker(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && SCRUBBED.has(value.__scrubbed)
}

function normalizedKey(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_')
}

function isSecretKey(key) {
  return SECRET_KEY.test(normalizedKey(key))
}

function assertAllowedKey(key) {
  if (FORBIDDEN_KEYS.has(key)) throw new Error('Settings sync rejected an unsafe object key.')
  if (containsAbsolutePath(key)) throw new Error('Settings sync rejected an absolute path in an object key.')
}

function isAbsolutePath(value) {
  return value.startsWith('file://')
    || value.startsWith('~/')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
}

function containsAbsolutePath(value) {
  if (isAbsolutePath(value)) return true
  return value
    .split(/[\s=,;]+/)
    .map((part) => part.replace(/^["']|["']$/g, ''))
    .some((part) => isAbsolutePath(part))
}

function assertOnlyKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  for (const key of Object.keys(value)) {
    assertAllowedKey(key)
    if (!allowed.has(key)) throw new Error(`Settings sync rejected an unsupported ${label} field.`)
  }
}

function assertSettingsShape(settings) {
  if (settings.theme !== undefined && settings.theme !== 'light' && settings.theme !== 'dark') {
    throw new Error('Settings sync rejected an invalid theme.')
  }
  if (settings.updateCheck !== undefined && typeof settings.updateCheck !== 'boolean') {
    throw new Error('Settings sync rejected an invalid update preference.')
  }
  if (settings.activeProfile !== undefined && typeof settings.activeProfile !== 'string') {
    throw new Error('Settings sync rejected an invalid active profile.')
  }
  const assertSources = (sources) => {
    if (!Array.isArray(sources)) throw new Error('Settings sync rejected invalid source definitions.')
    for (const source of sources) {
      assertOnlyKeys(source, SOURCE_KEYS, 'source')
      if (source.cache !== undefined) assertOnlyKeys(source.cache, CACHE_KEYS, 'source cache')
    }
  }
  if (settings.sources !== undefined) assertSources(settings.sources)
  if (settings.profiles !== undefined) {
    if (Array.isArray(settings.profiles)) {
      for (const profile of settings.profiles) {
        assertOnlyKeys(profile, PROFILE_KEYS, 'profile')
        if (profile.preferences !== undefined) assertOnlyKeys(profile.preferences, PROFILE_PREFERENCE_KEYS, 'profile preference')
        if (profile.sources !== undefined && (!Array.isArray(profile.sources) || profile.sources.some((item) => typeof item !== 'string'))) {
          throw new Error('Settings sync rejected invalid profile source references.')
        }
      }
    } else {
      if (!settings.profiles || typeof settings.profiles !== 'object') {
        throw new Error('Settings sync rejected invalid profile definitions.')
      }
      for (const [name, profile] of Object.entries(settings.profiles)) {
        assertAllowedKey(name)
        assertOnlyKeys(profile, MANIFEST_PROFILE_KEYS, 'manifest profile')
        if (profile.preferences !== undefined) assertOnlyKeys(profile.preferences, PROFILE_PREFERENCE_KEYS, 'profile preference')
        assertSources(profile.layers)
      }
    }
  }
}

/** Scrub machine paths and indirect secret references at every nesting level. */
export function scrubSettings(value, key = '') {
  const normalized = key.toLowerCase()
  if (normalized === 'command' || normalized === 'args') return scrubMarker('execution')
  if (normalized === 'path' || normalized === 'dir') return scrubMarker('path')
  if (typeof value === 'string') {
    if (normalized === 'tokenenv' || value.toLowerCase().startsWith('keychain:')) {
      return scrubMarker('secret')
    }
    if (containsAbsolutePath(value)) return scrubMarker('path')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => scrubSettings(entry, key))
  if (!value || typeof value !== 'object') return value
  if (isMarker(value)) return value

  const out = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    out[childKey] = scrubSettings(childValue, childKey)
  }
  return out
}

/** Only approved settings metadata can enter the payload at all. */
export function selectSyncSettings(settings) {
  const selected = {}
  for (const field of SYNC_FIELDS) {
    if (settings && Object.hasOwn(settings, field) && settings[field] !== undefined) selected[field] = settings[field]
  }
  return selected
}

/** Reject anything suspicious that survived deterministic scrubbing. */
export function assertSafeSyncPayload(value, key = '') {
  if (isMarker(value)) return
  if (isSecretKey(key)) throw new Error('Settings sync rejected a possible credential field.')
  if (CONTEXT_KEY.test(key)) throw new Error('Settings sync rejected context content.')
  if (typeof value === 'string') {
    const gitSshUrl = /^git@[\w.-]+:/.test(value)
    if (CREDENTIAL_VALUE.test(value) || SECRET_ASSIGNMENT.test(value) || (!gitSshUrl && EMAIL_VALUE.test(value))) {
      throw new Error('Settings sync rejected a possible credential, personal identifier, or context value.')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeSyncPayload(entry, key)
    return
  }
  if (!value || typeof value !== 'object') return
  if (Object.hasOwn(value, '__scrubbed')) {
    throw new Error('Settings sync rejected a malformed scrub marker.')
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    if (CONTEXT_KEY.test(childKey)) {
      throw new Error('Settings sync rejected context content.')
    }
    assertSafeSyncPayload(childValue, childKey)
  }
}

/** Validate renderer-provided local metadata before writing any plaintext file. */
export function assertSafeLocalSettings(value, key = '') {
  if (typeof value === 'string') {
    if (key.toLowerCase() === 'tokenenv' && ENV_NAME.test(value)) return
    if (value.toLowerCase().startsWith('keychain:')) return
    const gitSshUrl = /^git@[\w.-]+:/.test(value)
    if (isSecretKey(key) || CONTEXT_KEY.test(key) || CREDENTIAL_VALUE.test(value) || SECRET_ASSIGNMENT.test(value) || (!gitSshUrl && EMAIL_VALUE.test(value))) {
      throw new Error('Local settings rejected a possible plaintext credential, personal identifier, or context value.')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeLocalSettings(entry, key)
    return
  }
  if (!value || typeof value !== 'object') return
  if (isSecretKey(key) || CONTEXT_KEY.test(key)) {
    throw new Error('Local settings rejected a possible plaintext credential or context field.')
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    assertAllowedKey(childKey)
    assertSafeLocalSettings(childValue, childKey)
  }
}

export function prepareSyncPayload(settings) {
  const selected = selectSyncSettings(settings)
  assertSettingsShape(selected)
  const payload = scrubSettings(selected)
  assertSafeSyncPayload(payload)
  if (JSON.stringify(payload).length > MAX_SYNC_JSON) throw new Error('Settings sync payload is too large.')
  return payload
}

function mergeRemoteValue(local, remote) {
  if (isMarker(remote)) return local
  if (Array.isArray(remote)) {
    const localArray = Array.isArray(local) ? local : []
    return remote.map((entry, index) => {
      const identity = entry && typeof entry === 'object' && (entry.name ?? entry.id)
      const localEntry = identity
        ? localArray.find((candidate) => candidate && typeof candidate === 'object' && (candidate.name ?? candidate.id) === identity)
        : localArray[index]
      return mergeRemoteValue(localEntry, entry)
    })
  }
  if (!remote || typeof remote !== 'object') return remote

  const out = local && typeof local === 'object' && !Array.isArray(local) ? { ...local } : {}
  for (const [key, value] of Object.entries(remote)) {
    assertAllowedKey(key)
    const merged = mergeRemoteValue(out[key], value)
    if (merged !== undefined) out[key] = merged
  }
  return out
}

/** Remote metadata wins, except scrubbed machine-local values stay local. */
export function mergeSyncedSettings(local, remote) {
  return mergeRemoteValue(local, remote)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const { sources: _sources, ...diskValue } = value
  fs.writeFileSync(temporary, `${JSON.stringify(diskValue, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function createSettingsSync({ authManager, supabaseClient, localSettingsPath }) {
  const events = new EventEmitter()
  let state = { status: 'idle' }
  let operations = Promise.resolve()

  const setState = (next) => {
    state = next
    events.emit('status-changed', state)
  }

  async function requireSession() {
    const session = await authManager.getSession()
    if (!session?.user?.id) throw new Error('Sign in to sync settings.')
    return session
  }

  function enqueue(operation) {
    const result = operations.then(operation, operation)
    operations = result.catch(() => {})
    return result
  }

  async function pushNow(settings) {
    setState({ status: 'syncing' })
    try {
      const session = await requireSession()
      const blob = prepareSyncPayload(settings)
      const { data, error } = await supabaseClient
        .from('user_settings')
        .upsert({ user_id: session.user.id, blob }, { onConflict: 'user_id' })
        .select('updated_at')
        .single()
      if (error) throw error
      const updatedAt = data?.updated_at ?? null
      const current = readJson(localSettingsPath)
      const changedDuringPush = current?._sync?.localUpdatedAt
        && current._sync.localUpdatedAt !== settings?._sync?.localUpdatedAt
      const persisted = changedDuringPush ? current : settings
      const next = {
        ...persisted,
        _sync: {
          ...(persisted?._sync ?? {}),
          dirty: changedDuringPush ? persisted?._sync?.dirty === true : false,
          dirtyFields: changedDuringPush ? (persisted?._sync?.dirtyFields ?? []) : [],
          serverUpdatedAt: updatedAt,
        },
      }
      writeJson(localSettingsPath, next)
      setState({ status: 'synced', updatedAt })
      return { settings: next, updatedAt, overwritten: false }
    } catch (err) {
      setState({ status: 'error', message: 'Settings could not sync. Local settings are unchanged.' })
      throw err
    }
  }

  async function pullNow(currentSettings) {
    setState({ status: 'syncing' })
    try {
      const session = await requireSession()
      const local = readJson(localSettingsPath)
      const current = currentSettings ?? local
      const { data, error } = await supabaseClient
        .from('user_settings')
        .select('blob, updated_at')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (error) throw error
      if (!data) {
        if (local?._sync?.dirty === true) return pushNow(current)
        setState({ status: 'idle' })
        return null
      }

      const remote = prepareSyncPayload(data.blob ?? {})
      if (local?._sync?.dirty === true) {
        const mergedForPush = mergeSyncedSettings(current, remote)
        for (const field of local._sync.dirtyFields ?? []) {
          if (Object.hasOwn(current, field)) mergedForPush[field] = current[field]
        }
        mergedForPush._sync = local._sync
        return pushNow(mergedForPush)
      }

      const localPayload = selectSyncSettings(current)
      const merged = mergeSyncedSettings(current, remote)
      merged._sync = { ...(merged._sync ?? {}), dirty: false, dirtyFields: [], serverUpdatedAt: data.updated_at }
      const overwritten = Object.keys(localPayload).length > 0
        && !isDeepStrictEqual(localPayload, selectSyncSettings(merged))
      writeJson(localSettingsPath, merged)
      setState({ status: 'synced', updatedAt: data.updated_at, overwritten })
      return { settings: merged, updatedAt: data.updated_at, overwritten }
    } catch (err) {
      setState({ status: 'error', message: 'Settings could not sync. Local settings are unchanged.' })
      throw err
    }
  }

  return {
    push: (settings) => supabaseClient ? enqueue(() => pushNow(settings)) : null,
    pull: (currentSettings) => supabaseClient ? enqueue(() => pullNow(currentSettings)) : null,
    getState: () => state,
    on: events.on.bind(events),
    off: events.off.bind(events),
  }
}
