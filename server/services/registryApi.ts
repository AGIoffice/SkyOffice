export interface RegistryOffice {
  id?: string
  officeId: string
  domain?: string | null
  namespaceSlug?: string | null
  displayName?: string | null
  status?: string | null
  metadata?: Record<string, unknown> | null
}

export interface RegistryAgent {
  id: string
  agentIdentifier?: string | null
  displayName?: string | null
  avatarId?: string | null
  workstationId?: string | null
  position?: { x?: number; y?: number } | null
  role?: string | null
  officeId?: string | null
  voiceAgentId?: string | null
  metadata?: Record<string, unknown> | null
}

type HeadersInitLike = Record<string, string>

const BASE_URL =
  process.env.REGISTRY_SERVICE_URL ||
  process.env.REGISTRY_SERVICE_ORIGIN ||
  process.env.REGISTRY_SERVICE_BASE_URL ||
  'http://localhost:4000'

const fetchFn = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null
const AbortCtor = typeof globalThis.AbortController === 'function' ? globalThis.AbortController : null
const SERVICE_TOKEN =
  process.env.REGISTRY_SERVICE_TOKEN ||
  process.env.REGISTRY_API_TOKEN ||
  process.env.REGISTRY_SERVICE_AUTH_TOKEN ||
  null

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5000) {
  if (!AbortCtor) return promise
  const controller = new AbortCtor()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return promise.finally(() => clearTimeout(timer))
}

function buildHeaders(base?: HeadersInitLike): HeadersInitLike {
  const headers: HeadersInitLike = { Accept: 'application/json', ...(base ?? {}) }
  if (SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${SERVICE_TOKEN}`
    headers['X-Registry-Service-Token'] = SERVICE_TOKEN
  }
  return headers
}

export async function fetchRegistryOffices(): Promise<RegistryOffice[]> {
  if (!fetchFn) return []
  try {
    const response = await withTimeout(
      fetchFn(`${BASE_URL}/offices`, { method: 'GET', headers: buildHeaders() })
    )
    if (!response.ok) {
      console.warn('[registry-api] failed to fetch offices', response.status)
      return []
    }
    const data = await response.json()
    return Array.isArray(data) ? (data as RegistryOffice[]) : []
  } catch (err) {
    console.warn('[registry-api] error fetching offices', err)
    return []
  }
}

export async function fetchRegistryAgents(officeId: string): Promise<RegistryAgent[]> {
  if (!fetchFn) return []
  try {
    const response = await withTimeout(
      fetchFn(`${BASE_URL}/offices/${encodeURIComponent(officeId)}/agents`, {
        method: 'GET',
        headers: buildHeaders(),
      })
    )
    if (!response.ok) {
      console.warn('[registry-api] failed to fetch agents', officeId, response.status)
      return []
    }
    const data = await response.json()
    return Array.isArray(data) ? (data as RegistryAgent[]) : []
  } catch (err) {
    console.warn('[registry-api] error fetching agents', officeId, err)
    return []
  }
}

export async function patchRegistryAgent(
  officeId: string,
  agentId: string,
  body: Record<string, unknown>
) {
  if (!fetchFn) return
  try {
    const response = await withTimeout(
      fetchFn(
        `${BASE_URL}/offices/${encodeURIComponent(officeId)}/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PATCH',
          headers: buildHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body ?? {}),
        }
      )
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn(
        '[registry-api] failed to patch agent',
        officeId,
        agentId,
        response.status,
        text
      )
    }
  } catch (err) {
    console.warn('[registry-api] error patching agent', officeId, agentId, err)
  }
}

export async function patchRegistryOffice(
  officeId: string,
  body: Record<string, unknown>
) {
  if (!fetchFn) return
  try {
    const response = await withTimeout(
      fetchFn(`${BASE_URL}/offices/${encodeURIComponent(officeId)}`, {
        method: 'PATCH',
        headers: buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body ?? {}),
      })
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.warn(
        '[registry-api] failed to patch office',
        officeId,
        response.status,
        text
      )
    }
  } catch (err) {
    console.warn('[registry-api] error patching office', officeId, err)
  }
}
