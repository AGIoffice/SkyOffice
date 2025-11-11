const BASE_URL =
  process.env.REGISTRY_SERVICE_URL ||
  process.env.REGISTRY_SERVICE_ORIGIN ||
  process.env.REGISTRY_SERVICE_BASE_URL ||
  process.env.REGISTRY_API_URL ||
  'http://localhost:4000'

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null
const secretCache = new Map<string, string>()

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

export async function resolvePresenceSecret(agentId: string, officeId?: string | null) {
  const staticSecret =
    process.env.MANAGER_TOKEN_SECRET ||
    process.env.SKYOFFICE_MANAGER_SECRET ||
    process.env.PRESENCE_MANAGER_SECRET ||
    null
  if (staticSecret) return staticSecret
  if (!fetchFn) return null

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
  if (secretCache.has(cacheKey)) {
    return secretCache.get(cacheKey) ?? null
  }

  try {
    const response = await fetchFn(
      `${BASE_URL}/offices/${encodeURIComponent(
        resolvedOfficeId
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
        resolvedOfficeId,
        agentId,
        response.status,
        text
      )
      return null
    }

    const data = (await response.json()) as { sharedSecret?: string; shared_secret?: string }
    const secret =
      typeof data?.sharedSecret === 'string'
        ? data.sharedSecret
        : typeof data?.shared_secret === 'string'
          ? data.shared_secret
          : null

    if (!secret) {
      console.warn(
        '[presence-secret] Registry response missing sharedSecret',
        resolvedOfficeId,
        agentId
      )
      return null
    }

    secretCache.set(cacheKey, secret)
    return secret
  } catch (err) {
    console.warn('[presence-secret] Error fetching presence credential', resolvedOfficeId, agentId, err)
    return null
  }
}
