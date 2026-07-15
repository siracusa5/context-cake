import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadSupabaseConfig } from '../src/main/supabase-config.mjs'

test('config priority is environment, userData, then packaged public config', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextcake-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const packaged = path.join(dir, 'packaged.json')
  fs.writeFileSync(packaged, JSON.stringify({ url: 'https://packaged.supabase.co', anonKey: 'packaged' }))

  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {}, packaged), {
    url: 'https://packaged.supabase.co', anonKey: 'packaged',
  })
  fs.mkdirSync(path.join(dir, 'user'))
  fs.writeFileSync(path.join(dir, 'user', 'supabase.json'), JSON.stringify({ url: 'https://user.supabase.co', anonKey: 'user' }))
  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {}, packaged), {
    url: 'https://user.supabase.co', anonKey: 'user',
  })
  assert.deepEqual(loadSupabaseConfig(path.join(dir, 'user'), {
    SUPABASE_URL: 'https://env.supabase.co', SUPABASE_ANON_KEY: 'env',
  }, packaged), { url: 'https://env.supabase.co', anonKey: 'env' })
})

test('non-HTTPS project URLs leave auth unavailable', () => {
  assert.deepEqual(loadSupabaseConfig('/missing', {
    SUPABASE_URL: 'http://example.test', SUPABASE_ANON_KEY: 'public',
  }), { url: '', anonKey: '' })
})
