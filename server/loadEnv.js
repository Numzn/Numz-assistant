import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Loads .env, then .env.secrets, which wins over .env.
 *
 * NUMZ_SKIP_ENV_FILES=1 loads neither. Tests that start a real server set it, so they run against the
 * configuration they pass in rather than the developer's real secrets (which would override it).
 *
 * @returns {string[]} the names of the files that were considered
 */
export function loadEnvFiles({ rootDir = defaultRoot, env = process.env } = {}) {
  if (env.NUMZ_SKIP_ENV_FILES === '1') return []
  dotenv.config({ path: path.join(rootDir, '.env'), processEnv: env })
  dotenv.config({ path: path.join(rootDir, '.env.secrets'), override: true, processEnv: env })
  return ['.env', '.env.secrets']
}

loadEnvFiles()
