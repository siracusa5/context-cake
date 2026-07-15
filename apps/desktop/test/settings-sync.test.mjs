import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertSafeLocalSettings,
  assertSafeSyncPayload,
  createSettingsSync,
  mergeSyncedSettings,
  prepareSyncPayload,
  scrubSettings,
} from '../src/main/settings-sync.mjs'

test('scrubSettings recursively removes absolute paths and indirect secrets', () => {
  const scrubbed = scrubSettings({
    theme: 'dark',
    profiles: [{ root: '/Users/dana/company', nested: { cache: 'C:\\Users\\dana\\cache' } }],
    sources: [
      { name: 'team', path: '~/ContextCake/team', credential: 'keychain:contextcake/team' },
      { name: 'mcp', tokenEnv: 'GITHUB_TOKEN', command: 'node', args: ['./server.mjs'] },
    ],
  })
  assert.deepEqual(scrubbed, {
    theme: 'dark',
    profiles: [{ root: { __scrubbed: 'path' }, nested: { cache: { __scrubbed: 'path' } } }],
    sources: [
      { name: 'team', path: { __scrubbed: 'path' }, credential: { __scrubbed: 'secret' } },
      { name: 'mcp', tokenEnv: { __scrubbed: 'secret' }, command: { __scrubbed: 'execution' }, args: { __scrubbed: 'execution' } },
    ],
  })
})

test('prepareSyncPayload allowlists metadata and rejects credentials or context', () => {
  assert.deepEqual(prepareSyncPayload({ theme: 'light', updateCheck: true, privateNotes: 'never upload' }), {
    theme: 'light',
    updateCheck: true,
  })
  assert.throws(
    () => prepareSyncPayload({ sources: [{ credential: 'Bearer definitely-a-secret' }] }),
    /possible credential/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ content: 'company strategy' }),
    /context content/,
  )
  assert.deepEqual(prepareSyncPayload({ sources: [{ repo: 'git@github.com:ContextCake/private-pack.git' }] }), {
    sources: [{ repo: 'git@github.com:ContextCake/private-pack.git' }],
  })
  assert.throws(
    () => prepareSyncPayload(JSON.parse('{"profiles":[{"__proto__":{"polluted":true}}]}')),
    /unsafe object key/,
  )
  assert.throws(
    () => prepareSyncPayload({ sources: [{ name: 'team', headers: {} }] }),
    /unsupported source field/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ value: { __scrubbed: 'path', credential: 'plain' } }),
    /malformed scrub marker/,
  )
  assert.throws(
    () => assertSafeSyncPayload({ sources: [{ name: 'mcp', args: ['--api-key=short-but-secret'] }] }),
    /possible credential/,
  )
})

test('embedded paths and path-shaped object keys are scrubbed or rejected', () => {
  assert.deepEqual(prepareSyncPayload({ sources: [{ name: 'team', path: './team', args: ['--config=/Users/dana/private.json'] }] }), {
    sources: [{ name: 'team', path: { __scrubbed: 'path' }, args: { __scrubbed: 'execution' } }],
  })
  assert.throws(
    () => scrubSettings({ '/Users/dana/private.json': 'value' }),
    /absolute path in an object key/,
  )
})

test('remote MCP executable fields are quarantined and can only restore local values', () => {
  const remote = prepareSyncPayload({
    sources: [{ name: 'company', level: 0, source: 'mcp', command: '/tmp/evil', args: ['--steal'] }],
  })
  assert.deepEqual(remote.sources[0], {
    name: 'company',
    level: 0,
    source: 'mcp',
    command: { __scrubbed: 'execution' },
    args: { __scrubbed: 'execution' },
  })
  assert.deepEqual(mergeSyncedSettings({
    sources: [{ name: 'company', level: 0, source: 'mcp', command: 'node', args: ['./trusted.mjs'] }],
  }, remote).sources[0], {
    name: 'company', level: 0, source: 'mcp', command: 'node', args: ['./trusted.mjs'],
  })
  assert.deepEqual(mergeSyncedSettings({ sources: [] }, remote).sources[0], {
    name: 'company', level: 0, source: 'mcp',
  })
})

test('manifest-v2 profiles round-trip while local layer execution stays local', () => {
  const local = {
    profiles: {
      default: {
        layers: [{ name: 'personal', level: 3, path: '/Users/dana/kb' }],
      },
      company: {
        layers: [{ name: 'graph', level: 0, source: 'mcp', command: 'node', args: ['./graph.mjs'] }],
      },
    },
  }
  const remote = prepareSyncPayload(local)
  assert.deepEqual(remote, {
    profiles: {
      default: { layers: [{ name: 'personal', level: 3, path: { __scrubbed: 'path' } }] },
      company: { layers: [{ name: 'graph', level: 0, source: 'mcp', command: { __scrubbed: 'execution' }, args: { __scrubbed: 'execution' } }] },
    },
  })
  assert.deepEqual(mergeSyncedSettings(local, remote), local)
  assert.deepEqual(mergeSyncedSettings({}, remote), {
    profiles: {
      default: { layers: [{ name: 'personal', level: 3 }] },
      company: { layers: [{ name: 'graph', level: 0, source: 'mcp' }] },
    },
  })
})

test('local settings reject plaintext PII and credentials before disk persistence', () => {
  assert.doesNotThrow(() => assertSafeLocalSettings({
    sources: [{ path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN', credential: 'keychain:contextcake/team' }],
  }))
  assert.throws(() => assertSafeLocalSettings({ profiles: [{ email: 'person@example.com' }] }), /plaintext/)
  assert.throws(() => assertSafeLocalSettings({ sources: [{ accessToken: 'plain-secret' }] }), /plaintext/)
})

test('remote scrub markers preserve machine-local values during pull', () => {
  const merged = mergeSyncedSettings(
    { theme: 'dark', sources: [{ name: 'team', path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN' }] },
    { theme: 'light', sources: [{ name: 'team', path: { __scrubbed: 'path' }, tokenEnv: { __scrubbed: 'secret' } }] },
  )
  assert.deepEqual(merged, {
    theme: 'light',
    sources: [{ name: 'team', path: '/Users/local/team', tokenEnv: 'TEAM_TOKEN' }],
  })
})

test('a dirty offline edit is pushed before a remote pull', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-sync-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({ theme: 'light', _sync: { dirty: true } }))
  let operation = ''
  const supabaseClient = {
    from() {
      return {
        upsert() {
          operation = 'upsert'
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T20:00:00Z' }, error: null }) }) }
        },
        select() {
          operation = 'select'
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
  })
  const result = await sync.pull()
  assert.equal(operation, 'upsert')
  assert.equal(result.overwritten, false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))._sync.dirty, false)
})

test('dirty fields override remote while untouched remote metadata is retained', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-reconcile-'))
  const file = path.join(dir, 'settings.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify({
    theme: 'light',
    _sync: { dirty: true, dirtyFields: ['theme'], localUpdatedAt: '2026-07-14T20:00:00Z' },
  }))
  let uploaded = null
  const supabaseClient = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({
            data: { blob: { theme: 'dark', profiles: [{ id: 'work', name: 'Work' }] }, updated_at: '2026-07-14T19:00:00Z' },
            error: null,
          }) }) }
        },
        upsert(row) {
          uploaded = row.blob
          return { select: () => ({ single: async () => ({ data: { updated_at: '2026-07-14T21:00:00Z' }, error: null }) }) }
        },
      }
    },
  }
  const sync = createSettingsSync({
    authManager: { getSession: async () => ({ user: { id: 'user-1' } }) },
    supabaseClient,
    localSettingsPath: file,
  })
  await sync.pull({ theme: 'light' })
  assert.deepEqual(uploaded, { theme: 'light', profiles: [{ id: 'work', name: 'Work' }] })
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'sources'), false)
})
