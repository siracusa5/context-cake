import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve public Supabase project credentials without baking secrets into the
 * repository. Packaged builds may provision supabase.json in userData; local
 * development uses SUPABASE_* (with VITE_* accepted for the shared dev env).
 */
export function loadSupabaseConfig(configDir, env = process.env, packagedConfigPath = '') {
  let packaged = {}
  let user = {}
  try {
    if (packagedConfigPath) packaged = JSON.parse(fs.readFileSync(packagedConfigPath, 'utf8'))
  } catch { /* an unconfigured build remains fully usable locally */ }
  try {
    user = JSON.parse(fs.readFileSync(path.join(configDir, 'supabase.json'), 'utf8'))
  } catch { /* an unconfigured build remains fully usable locally */ }

  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || user.url || packaged.url
  const anonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || user.anonKey || packaged.anonKey
  if (!url || !anonKey) return { url: '', anonKey: '' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return { url: '', anonKey: '' }
  } catch {
    return { url: '', anonKey: '' }
  }
  return { url, anonKey }
}
