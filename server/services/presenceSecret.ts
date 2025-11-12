import { fetchOfficeTenantKeys, RegistryTenantKey } from './registryApi'
import { getSecretString } from './awsSecrets'

const BASE_URL =
  process.env.REGISTRY_SERVICE_URL ||
  process.env.REGISTRY_SERVICE_ORIGIN ||
  process.env.REGISTRY_SERVICE_BASE_URL ||
  process.env.REGISTRY_API_URL ||
  'http://localhost:4000'

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null

type PresenceSecretSource = 'static' | 'tenant-keys' | 'registry'

interface PresenceSecretCacheEntry {
  secret: string
  source: PresenceSecretSource
  timestamp: number
}

const SECRET_CACHE_TTL_MS = Number(process.env.PRESENCE_SECRET_CACHE_MS || 5 * 60 * 1000)
const TENANT_SHARED_SECRET_CACHE_MS = Number(
  process.env.TENANT_SHARED_SECRET_CACHE_MS || 5 * 60 * 1000
)

const secretCache = new Map<string, PresenceSecretCacheEntry>()
const tenantSharedSecretCache = new Map<string, { secret: string; timestamp: number }>()
const tenantSecretLog = new Set<string>()

function buildAuthHeaders(base: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...base }
  const token =
    (process.env.REGISTRY_SERVICE_TOKEN && process.env.REGISTRY_SERVICE_TOKEN.trim()) ||
    (process.env.REGISTRY_API_TOKEN && process.env.REGISTRY_API_TOKEN.trim()) ||
    null

  if (token) {
    if (!headers.Authorization) {
      headers.Authorization = `Bearer ${token}`
    }
    if (!headers['X-Registry-Service-Token']) {
      headers['X-Registry-Service-Token'] = token
    }
  }

  return headers
}

function parseSecretEntries(secretString: string): Record<string, string> {
  if (!secretString) return {}
  try {
    const parsed = JSON.parse(secretString)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, string> = {}
      Object.entries(parsed).forEach(([key, value]) => {
        if (typeof value === 'string') {
          result[key] = value
        } else if (value !== undefined && value !== null) {
          result[key] = String(value)
        }
      })
      return result
    }
  } catch {
    // fall through to env-style parser
  }

  const entries: Record<string, string> = {}
  secretString
    .split(/\r?\n/)
    .map((line) => line.trim())
  secretString
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line || line.startsWith('#')) return
      const idx = line.indexOf('=')
      if (idx === -1) return
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key) {
        entries[key] = value
      }
    })

  return entries
}

function selectPresenceSecret(entries: Record<string, string>): string | null {
  if (!entries) return null
  return (
    entries['SKYOFFICE_PRESENCE_SHARED_SECRET'] ||
    entries['SKYOFFICE_PRESENCE_SECRET'] ||
    entries['PRESENCE_SHARED_SECRET'] ||
    entries['sharedSecret'] ||
    entries['shared_secret'] ||
    null
  )
}

function extractSkyofficeSecretPaths(key: RegistryTenantKey): string[] {
  if (!key) return []
  const metadataPaths = Array.isArray((key as any)?.metadata?.paths)
    ? ((key as any).metadata.paths as string[])
    : []
  const candidates = [
    ...(metadataPaths.filter((entry) => typeof entry === 'string').map((entry) => entry.trim())),
  ]
  if (typeof key.secretsPath === 'string' && key.secretsPath.trim()) {
    candidates.push(key.secretsPath.trim())
  }
  const seen = new Set<string>()
  const unique: string[] = []
  candidates.forEach((entry) => {
    if (!entry) return
    if (seen.has(entry)) return
    seen.add(entry)
    unique.push(entry)
  })
  return unique
}

async function loadSecretFromTenantKeys(officeId: string): Promise<string | null> {
  const tenantKeys = await fetchOfficeTenantKeys(officeId)
  const skyofficeKey = tenantKeys.find(
    (key) =>
      typeof key?.keyType === 'string' &&
      key.keyType.toLowerCase() === 'shared:skyoffice-server'
  )
  if (!skyofficeKey) {
    return null
  }
  const paths = extractSkyofficeSecretPaths(skyofficeKey)
  if (!paths.length) return null
  const secretId = paths[0]
  const cached = tenantSharedSecretCache.get(secretId)
  if (cached && Date.now() - cached.timestamp < TENANT_SHARED_SECRET_CACHE_MS) {
    return cached.secret
  }
  try {
    const secretString = await getSecretString(secretId)
    const entries = parseSecretEntries(secretString)
    const candidate = selectPresenceSecret(entries)
    if (!candidate) {
      return null
    }
    tenantSharedSecretCache.set(secretId, { secret: candidate, timestamp: Date.now() })
    if (!tenantSecretLog.has(secretId)) {
      tenantSecretLog.add(secretId)
      console.log('[presence-secret] Loaded SkyOffice secret via tenant key', {
        officeId,
        secretId,
      })
    }
    return candidate
  } catch (error) {
    console.warn(
      '[presence-secret] Failed to load presence secret from tenant key',
      secretId,
      (error as Error).message || error
    )
    return null
  }
}

async function fetchPresenceSecretFromRegistry(agentId: string, officeId: string) {
  if (!fetchFn) return null
  try {
    const response = await fetchFn(
      `${BASE_URL}/offices/${encodeURIComponent(
        officeId
      )}/presence/agents/${encodeURIComponent(agentId)}/credential`,
      {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      }
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn(
        '[presence-secret] Failed to load presence credential',
        officeId,
        agentId,
        response.status,
        text
      )
      return null
    }

    const data = (await response.json()) as { sharedSecret?: string; shared_secret?: string }
    return typeof data?.sharedSecret === 'string'
      ? data.sharedSecret
      : typeof data?.shared_secret === 'string'
        ? data.shared_secret
        : null
  } catch (err) {
    console.warn('[presence-secret] Error fetching presence credential', officeId, agentId, err)
    return null
  }
}

export async function resolvePresenceSecret(
  agentId: string,
  officeId?: string | null
): Promise<PresenceSecretCacheEntry | null> {
  const staticSecret =
    process.env.SKYOFFICE_PRESENCE_SHARED_SECRET ||
    process.env.SKYOFFICE_PRESENCE_SECRET ||
    process.env.PRESENCE_SHARED_SECRET ||
    process.env.SHARED_SECRET ||
    null
  if (staticSecret) {
    return { secret: staticSecret, source: 'static', timestamp: Date.now() }
  }

  const resolvedOfficeId =
    officeId ||
    process.env.REGISTRY_OFFICE_ID ||
    process.env.OFFICE_ID ||
    process.env.SKYOFFICE_OFFICE_ID ||
    null
  if (!resolvedOfficeId) {
    console.warn('[presence-secret] Cannot resolve officeId for presence credential')
    return null
  }

  const cacheKey = `${resolvedOfficeId}:${agentId.toLowerCase()}`
  const cachedEntry = secretCache.get(cacheKey)
  if (cachedEntry && Date.now() - cachedEntry.timestamp < SECRET_CACHE_TTL_MS) {
    return cachedEntry
  }

  const tenantSecret = await loadSecretFromTenantKeys(resolvedOfficeId)
  if (tenantSecret) {
    const entry: PresenceSecretCacheEntry = {
      secret: tenantSecret,
      source: 'tenant-keys',
      timestamp: Date.now(),
    }
    secretCache.set(cacheKey, entry)
    return entry
  }

  const registrySecret = await fetchPresenceSecretFromRegistry(agentId, resolvedOfficeId)
  if (registrySecret) {
    const entry: PresenceSecretCacheEntry = {
      secret: registrySecret,
      source: 'registry',
      timestamp: Date.now(),
    }
    secretCache.set(cacheKey, entry)
    return entry
  }

  return null
}
