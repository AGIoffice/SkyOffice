import http from 'http'
import https from 'https'
import { URL } from 'url'
import express from 'express'
import cors from 'cors'
import { Server, LobbyRoom, matchMaker } from 'colyseus'
import { monitor } from '@colyseus/monitor'
import { RoomType } from '../types/Rooms'
import { initDb } from './persistence/db'
import { clearAllRooms } from './persistence/RoomStore'
import { clearAllNpcs, saveNpc } from './persistence/NpcStore'

// import socialRoutes from "@colyseus/social/express"

import { SkyOffice } from './rooms/SkyOffice'

// Set seat reservation timeout to 15 seconds (default is 5)
process.env.COLYSEUS_SEAT_RESERVATION_TIME = '15'

const port = Number(process.env.PORT || 3010)
const app = express()

app.use(cors())
app.use(express.json())
// app.use(express.static('dist'))

import {
  fetchRegistryOffices,
  fetchRegistryAgents,
  patchRegistryAgent,
  RegistryAgent,
  RegistryOffice
} from './services/registryApi'
import { findPath as findWalkablePath } from './pathfinding/WalkableMap'

const DEFAULT_VOICE_AGENT_ID =
  process.env.DEFAULT_AGENT_VOICE_ID || 'agent_4901k6k9xg9qf4paratx1d9rkmwx'

const DEFAULT_AGENT_POSITION = { x: 800, y: 200 }
const DEFAULT_AGENT_WORKSTATION = 'design-studio'

const sanitizeLabel = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent'

async function ensureRegistryRooms() {
  const offices = await fetchRegistryOffices()
  const validNamespaces = new Set<string>()

  for (const office of offices) {
    const slug = office.namespaceSlug?.trim()
    if (!slug) continue
    const normalizedSlug = slug.toLowerCase()
    validNamespaces.add(normalizedSlug)
    const domainCandidate = office.domain?.trim().toLowerCase()
    if (domainCandidate) {
      validNamespaces.add(domainCandidate)
      const [head] = domainCandidate.split('.')
      if (head) validNamespaces.add(head)
    }

    try {
      const existingInstance = SkyOffice.getRoomByNamespaceSlug(normalizedSlug)
      if (!existingInstance) {
        const metadata: Record<string, unknown> = {
          registryOfficeId: office.officeId,
          registryId: office.id,
          registryDomain: office.domain,
          registryStatus: office.status,
          namespaceSlug: slug,
          displayName: office.displayName ?? slug,
          registryBacked: true,
        }
        if (office.metadata && typeof office.metadata === 'object') {
          metadata.registryMetadata = office.metadata
          if ('defaultAgentId' in office.metadata && !metadata.defaultAgentId) {
            metadata.defaultAgentId = (office.metadata as any).defaultAgentId
          }
        }

        const descriptionFromRegistry =
          (office.metadata?.description as string | undefined) || office.displayName || slug

        await matchMaker.createRoom(RoomType.CUSTOM, {
          name: slug,
          description: descriptionFromRegistry,
          password: null,
          autoDispose: false,
          namespaceSlug: slug,
          metadata,
        })
        console.log(`[registry-sync] Room for namespace '${slug}' created for office '${office.officeId}'`)
      }
    } catch (err) {
      console.error(`[registry-sync] Failed to prepare room for namespace '${slug}'`, err)
    }

    scheduleRegistryAgentSync(office)
  }

  try {
    await SkyOffice.pruneNamespacesNotIn(validNamespaces)
  } catch (err) {
    console.warn('[registry-sync] Failed to prune namespaces not found in registry', err)
  }
}

function scheduleRegistryAgentSync(office: RegistryOffice, attempt = 0) {
  const slug = office.namespaceSlug?.trim()
  if (!slug) return

  const delay = attempt === 0 ? 0 : Math.min(500 * attempt, 3000)

  setTimeout(async () => {
    const normalizedSlug = slug.toLowerCase()
    const roomInstance = SkyOffice.getRoomByNamespaceSlug(normalizedSlug)

    if (!roomInstance) {
      if (attempt < 8) {
        scheduleRegistryAgentSync(office, attempt + 1)
      } else {
        console.warn(`[registry-sync] Unable to locate room for '${normalizedSlug}' after retries`)
      }
      return
    }

    try {
      const agents = await fetchRegistryAgents(office.officeId)
      if (!agents.length) return

      const existingAgents = new Set(roomInstance.getNpcAssignments().map((npc) => npc.agentId))

      for (const agent of agents) {
        const resolvedAgentId = resolveAgentIdentifier(agent, office, normalizedSlug)
        if (!resolvedAgentId) continue

        const payload = buildNpcPayloadFromRegistry(agent, office, normalizedSlug, resolvedAgentId)
        if (!payload) continue

        const assignment = roomInstance.upsertNpc(payload, { skipPersistence: true })
        existingAgents.add(resolvedAgentId)

        try {
          saveNpc({
            agentId: assignment.agentId,
            registryAgentId: payload.registryAgentId || agent.id,
            officeId: payload.officeId || office.officeId,
            name: assignment.name,
            avatarId: assignment.avatarId,
            workstationId: assignment.workstationId,
            positionX: assignment.position?.x ?? DEFAULT_AGENT_POSITION.x,
            positionY: assignment.position?.y ?? DEFAULT_AGENT_POSITION.y,
            role: assignment.role,
            computerId: assignment.computerId,
            roomName: roomInstance.getRoomName(),
            voiceAgentId: assignment.voiceAgentId,
            namespaceSlug: payload.namespaceSlug || normalizedSlug,
            agentMetadata: payload.agentMetadata || null,
          })
        } catch (err) {
          console.warn('[registry-sync] Failed to persist NPC locally', resolvedAgentId, err)
        }
      }
    } catch (err) {
      console.error(`[registry-sync] Failed to sync agents for '${slug}'`, err)
    }
  }, delay)
}

function resolveAgentIdentifier(
  agent: RegistryAgent,
  office: RegistryOffice,
  namespaceSlug: string
) {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  const metadataDomain =
    (metadata.defaultAgentDomain as string | undefined) ||
    (metadata.agentDomain as string | undefined) ||
    (metadata.domain as string | undefined)

  if (metadataDomain && typeof metadataDomain === 'string' && metadataDomain.trim()) {
    return metadataDomain.trim().toLowerCase()
  }

  const identifier =
    (agent.agentIdentifier && agent.agentIdentifier.trim()) ||
    (metadata.defaultAgentId as string | undefined) ||
    (metadata.agentIdentifier as string | undefined) ||
    agent.id

  if (identifier && identifier.includes('.')) {
    return identifier.trim().toLowerCase()
  }

  const label = sanitizeLabel(identifier || 'agent')
  if (office.domain) {
    return office.domain.trim().toLowerCase()
  }

  const baseDomain = process.env.OFFICE_BASE_DOMAIN || 'office.xyz'
  return `${label}.${namespaceSlug}.${baseDomain}`.toLowerCase()
}

function buildNpcPayloadFromRegistry(
  agent: RegistryAgent,
  office: RegistryOffice,
  namespaceSlug: string,
  agentId: string
) {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>
  const spawnConfig =
    (metadata?.spawn as Record<string, unknown> | undefined) ||
    (metadata?.spawnConfig as Record<string, unknown> | undefined) ||
    metadata

  const positionSource = (spawnConfig?.position as Record<string, unknown> | undefined) || {}
  const position = {
    x: Number(positionSource.x ?? DEFAULT_AGENT_POSITION.x) || DEFAULT_AGENT_POSITION.x,
    y: Number(positionSource.y ?? DEFAULT_AGENT_POSITION.y) || DEFAULT_AGENT_POSITION.y,
  }

  const avatarId =
    (spawnConfig?.avatarId as string) || (metadata?.avatarId as string) || agent.avatarId || 'adam'

  const workstationId =
    (spawnConfig?.workstationId as string) ||
    (metadata?.workstationId as string) ||
    DEFAULT_AGENT_WORKSTATION

  const role =
    (spawnConfig?.role as string) ||
    (metadata?.role as string) ||
    agent.role ||
    'GM'

  const voiceAgentId =
    (spawnConfig?.voiceAgentId as string) ||
    (metadata?.voiceAgentId as string) ||
    agent.agentEmail ||
    DEFAULT_VOICE_AGENT_ID

  const rawAliases = Array.isArray(metadata?.aliases)
    ? (metadata?.aliases as Array<unknown>)
        .filter((entry): entry is string => typeof entry === 'string')
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
    : []
  const nicknameFromMetadata =
    (typeof metadata?.nickname === 'string' && metadata.nickname.trim()) ||
    null
  const aliasCandidate =
    rawAliases.find((alias) => alias !== agent.agentIdentifier && alias !== agentId) || null

  const displayName =
    (spawnConfig?.displayName as string) ||
    nicknameFromMetadata ||
    aliasCandidate ||
    (typeof metadata?.displayName === 'string' && metadata.displayName.trim()
      ? (metadata.displayName as string).trim()
      : null) ||
    agent.agentIdentifier ||
    agentId

  let safeMetadata: Record<string, unknown> | null = null
  if (metadata && typeof metadata === 'object') {
    try {
      safeMetadata = JSON.parse(JSON.stringify(metadata))
    } catch {
      safeMetadata = { ...metadata }
    }
  } else {
    safeMetadata = {}
  }

  const officeMetadata = (office.metadata ?? {}) as Record<string, unknown>
  const defaultAgentIdFromOffice = officeMetadata?.defaultAgentId as string | undefined
  const defaultAgentDomainFromOffice =
    (officeMetadata?.defaultAgentDomain as string | undefined) || office.domain || null
  const isDefaultByIdentifier =
    !!defaultAgentIdFromOffice &&
    typeof agent.agentIdentifier === 'string' &&
    agent.agentIdentifier === defaultAgentIdFromOffice
  const hasDefaultFlag =
    typeof (safeMetadata as Record<string, unknown>).default === 'boolean'
      ? Boolean((safeMetadata as any).default)
      : false

  if (isDefaultByIdentifier || hasDefaultFlag) {
    ;(safeMetadata as Record<string, unknown>).default = true
    if (!('defaultAgentId' in (safeMetadata as Record<string, unknown>)) && defaultAgentIdFromOffice) {
      ;(safeMetadata as Record<string, unknown>).defaultAgentId = defaultAgentIdFromOffice
    }
    if (
      !('defaultAgentDomain' in (safeMetadata as Record<string, unknown>)) &&
      defaultAgentDomainFromOffice
    ) {
      ;(safeMetadata as Record<string, unknown>).defaultAgentDomain = defaultAgentDomainFromOffice
    }
    if (
      !('agentDomain' in (safeMetadata as Record<string, unknown>)) &&
      defaultAgentDomainFromOffice
    ) {
      ;(safeMetadata as Record<string, unknown>).agentDomain = defaultAgentDomainFromOffice
    }
  }

  if (
    agent.agentEmail &&
    !(safeMetadata as Record<string, unknown>).defaultAgentEmail &&
    typeof agent.agentEmail === 'string'
  ) {
    ;(safeMetadata as Record<string, unknown>).defaultAgentEmail = agent.agentEmail
  }

  if (
    nicknameFromMetadata ||
    aliasCandidate
  ) {
    ;(safeMetadata as Record<string, unknown>).nickname = nicknameFromMetadata || aliasCandidate || null
  }
  ;(safeMetadata as Record<string, unknown>).displayName = displayName

  return {
    agentId,
    registryAgentId: agent.id,
    name: displayName,
    avatarId,
    workstationId,
    position,
    role,
    officeId: office.officeId,
    voiceAgentId,
    namespaceSlug,
    agentMetadata: safeMetadata ?? undefined,
  }
}

app.get('/healthz', (_req, res) => {
  res.json({
    success: true,
    service: 'skyoffice-server',
    uptime: process.uptime(),
    rooms: SkyOffice.getActiveRoomCount(),
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/deploy-character', async (req, res) => {
  const {
    agentId,
    name,
    avatarId,
    workstationId,
    position,
    role,
    officeId,
    roomId,
    voiceAgentId,
    namespaceSlug,
  } = req.body || {}

  if (!agentId || !name || !avatarId || !workstationId || !position) {
    return res.status(400).json({
      success: false,
      message: 'agentId, name, avatarId, workstationId, position 为必填项',
    })
  }

  const slugKey =
    typeof namespaceSlug === 'string' && namespaceSlug.trim() !== ''
      ? namespaceSlug.trim().toLowerCase()
      : undefined

  let targetRoom =
    (slugKey && SkyOffice.getRoomByNamespaceSlug(slugKey)) || undefined

  if (!targetRoom && slugKey) {
    try {
      const existingRooms = await matchMaker.query({ name: slugKey })
      if (existingRooms.length > 0) {
        const candidate = SkyOffice.getRoomById(existingRooms[0].roomId)
        if (candidate) {
          targetRoom = candidate
        }
      }
    } catch (err) {
      console.warn('[deploy-character] Failed to lookup room by namespaceSlug', slugKey, err)
    }
  }

  if (!targetRoom) {
    targetRoom =
      (typeof roomId === 'string' && SkyOffice.getRoomById(roomId)) ||
      SkyOffice.getAnyActiveRoom()
  }

  if (!targetRoom) {
    return res.status(503).json({
      success: false,
      message: '暂无可用的 SkyOffice 房间实例',
    })
  }

  const safePosition = {
    x: Number(position?.x) || 705,
    y: Number(position?.y) || 500,
  }

  const assignment = targetRoom.upsertNpc({
    agentId,
    name,
    avatarId,
    workstationId,
    position: safePosition,
    role,
    officeId,
    voiceAgentId,
    namespaceSlug: slugKey,
  })

  res.json({
    success: true,
    roomId: assignment.roomId,
    assignment,
  })
})

app.get('/api/npcs', (req, res) => {
  res.json({ success: true, data: SkyOffice.listNpcAssignments() })
})

app.get('/api/rooms/by-namespace/:slug', async (req, res) => {
  const slugRaw = String(req.params.slug || '').trim()
  if (!slugRaw) {
    return res.status(400).json({ success: false, message: 'namespaceSlug is required' })
  }
  const slug = slugRaw.toLowerCase()
  const info = SkyOffice.getNamespaceRoomInfo(slug)
  if (info) {
    return res.json({
      success: true,
      room: {
        roomId: info.roomId,
        namespaceSlug: info.namespaceSlug ?? slug,
        name: info.name,
      },
    })
  }

  try {
    const listings = await matchMaker.query({ name: slugRaw })
    if (Array.isArray(listings) && listings.length > 0) {
      const [listing] = listings
      return res.json({
        success: true,
        room: {
          roomId: listing.roomId,
          namespaceSlug: slug,
          name: listing.name,
        },
      })
    }
  } catch (err) {
    console.warn('[api] Failed to query rooms by namespace', slugRaw, err)
  }

  res.status(404).json({ success: false, message: 'Room not found for namespace', namespaceSlug: slugRaw })
})

app.get('/api/offices/:officeId/agents', async (req, res) => {
  const officeIdRaw = String(req.params.officeId || '').trim()
  if (!officeIdRaw) {
    return res.status(400).json({ success: false, message: 'officeId is required' })
  }

  const normalise = (value?: string | null) => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed.toLowerCase() : null
  }

  const normalisedInput = normalise(officeIdRaw)

  const fetchAgentsById = async (id: string) => {
    try {
      return await fetchRegistryAgents(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[api] Failed to load agents for office '${id}'`, err)
      return []
    }
  }

  let resolvedOfficeId: string | null = officeIdRaw
  let agents = await fetchAgentsById(officeIdRaw)

  const hasAgents = () => Array.isArray(agents) && agents.length > 0

  if (!hasAgents()) {
    try {
      const offices = await fetchRegistryOffices()
      if (offices.length > 0) {
        const match = offices.find((office: RegistryOffice) => {
          const officeId = normalise(office.officeId)
          const registryId = normalise((office as any).id)
          const slug = normalise(office.namespaceSlug)
          const domain = normalise(office.domain)
          if (!normalisedInput) return false
          return (
            officeId === normalisedInput ||
            registryId === normalisedInput ||
            slug === normalisedInput ||
            domain === normalisedInput ||
            (domain && normalisedInput.endsWith(domain))
          )
        })

        if (match) {
          resolvedOfficeId = match.officeId
          agents = await fetchAgentsById(match.officeId)
        }
      }
    } catch (err) {
      console.error('[api] Failed to reconcile offices for agent lookup', err)
    }
  }

  if (!hasAgents()) {
    const assignments = SkyOffice.listNpcAssignments()
    const fallbackAgents = assignments
      .filter((assignment) => {
        const assignmentOfficeId = normalise(assignment.officeId)
        const assignmentNamespace = normalise(assignment.namespaceSlug)
        if (assignmentOfficeId && assignmentOfficeId === normalisedInput) return true
        if (assignmentNamespace && assignmentNamespace === normalisedInput) return true
        const metadata = assignment.agentMetadata as Record<string, unknown> | undefined
        const metadataDomain =
          metadata && typeof metadata.defaultAgentDomain === 'string'
            ? normalise(metadata.defaultAgentDomain)
            : null
        const metadataId =
          metadata && typeof metadata.defaultAgentId === 'string'
            ? normalise(metadata.defaultAgentId)
            : null
        return (
          (metadataDomain && metadataDomain === normalisedInput) ||
          (metadataId && metadataId === normalisedInput)
        )
      })
      .map((assignment) => ({
        id: assignment.registryAgentId || assignment.agentId,
        officeId: assignment.officeId || resolvedOfficeId,
        agentIdentifier: assignment.agentId,
        agentEmail: null as string | null,
        role: assignment.role || null,
        avatarId: assignment.avatarId || null,
        inviteStatus: 'active',
        metadata: assignment.agentMetadata || null,
      }))

    if (fallbackAgents.length > 0) {
      return res.json({
        success: true,
        data: fallbackAgents,
        source: 'skyoffice',
      })
    }
  }

  res.json({
    success: true,
    data: agents,
    officeId: resolvedOfficeId,
    source: hasAgents() ? 'registry' : 'empty',
  })
})

app.delete('/api/rooms/:namespaceSlug', async (req, res) => {
  const namespaceSlug = String(req.params.namespaceSlug || '').trim().toLowerCase()
  if (!namespaceSlug) {
    return res.status(400).json({ success: false, message: 'namespaceSlug is required' })
  }

  try {
    const result = await SkyOffice.destroyNamespace(namespaceSlug)
    
    // Invalidate cache for removed agents and namespace (non-blocking)
    const chatBridgeUrl = process.env.CHAT_BRIDGE_URL || 'http://localhost:3020'
    if (result.removedAgents.length > 0 || namespaceSlug) {
      const cachePayload: {
        agentIds?: string[];
        namespaceSlug?: string;
      } = {};
      
      if (result.removedAgents.length > 0) {
        cachePayload.agentIds = result.removedAgents;
      }
      if (namespaceSlug) {
        cachePayload.namespaceSlug = namespaceSlug;
      }
      
      // Fire and forget - don't block response
      const url = new URL(`${chatBridgeUrl}/api/aladdin/cache/invalidate`)
      const httpModule = url.protocol === 'https:' ? https : http
      const postData = JSON.stringify(cachePayload)
      
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }
      
      const req = httpModule.request(options, (res) => {
        // Ignore response, just check for errors
        if (res.statusCode && res.statusCode >= 400) {
          console.warn('[skyoffice] Cache invalidation returned status:', res.statusCode)
        }
      })
      
      req.on('error', (err) => {
        console.warn('[skyoffice] Cache invalidation failed (non-blocking):', err.message)
      })
      
      req.write(postData)
      req.end()
    }
    
    res.json({ success: true, removedRooms: result.removedRooms, removedAgents: result.removedAgents })
  } catch (err) {
    console.error(`[rooms] Failed to destroy namespace '${namespaceSlug}'`, err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ success: false, message: 'Failed to destroy namespace', error: message })
  }
})

app.delete('/api/npcs/:agentId', (req, res) => {
  const { agentId } = req.params
  const anyRoom = SkyOffice.getAnyActiveRoom()
  if (!anyRoom) {
    return res.status(503).json({ success: false, message: '暂无可用房间' })
  }
  const removed = SkyOffice.removeNpcEverywhere(agentId)
  res.json({ success: true, removed })
})

app.post('/api/pathfind', (req, res) => {
  const start = req.body?.start
  const target = req.body?.target
  const isValidPoint = (point: any) =>
    point &&
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y)

  if (!isValidPoint(start) || !isValidPoint(target)) {
    return res.status(400).json({ success: false, message: 'Invalid start/target coordinates' })
  }

  const path = findWalkablePath(
    { x: Number(start.x), y: Number(start.y) },
    { x: Number(target.x), y: Number(target.y) }
  )
  if (!path || !path.length) {
    return res.status(404).json({ success: false, message: 'Path not found' })
  }
  res.json({ success: true, path })
})

app.post('/api/npcs/:agentId/persist', (req, res) => {
  const agentIdRaw = String(req.params.agentId || '').trim()
  if (!agentIdRaw) {
    return res.status(400).json({ success: false, message: 'agentId is required' })
  }
  const namespaceSlugRaw =
    typeof req.body?.namespaceSlug === 'string' ? req.body.namespaceSlug.trim().toLowerCase() : null

  const positionBody = req.body?.position
  const hasPosition =
    positionBody &&
    typeof positionBody.x === 'number' &&
    Number.isFinite(positionBody.x) &&
    typeof positionBody.y === 'number' &&
    Number.isFinite(positionBody.y)

  const updatePayload: {
    position?: { x: number; y: number }
    anim?: string
    posture?: string
    workstationId?: string
    voiceAgentId?: string
  } = {}

  if (hasPosition) {
    updatePayload.position = {
      x: Math.round(Number(positionBody.x)),
      y: Math.round(Number(positionBody.y)),
    }
  }

  if (typeof req.body?.anim === 'string' && req.body.anim.trim()) {
    updatePayload.anim = req.body.anim.trim()
  }

  if (typeof req.body?.posture === 'string' && req.body.posture.trim()) {
    updatePayload.posture = req.body.posture.trim()
  }

  if (typeof req.body?.workstationId === 'string' && req.body.workstationId.trim()) {
    updatePayload.workstationId = req.body.workstationId.trim()
  }

  if (typeof req.body?.voiceAgentId === 'string' && req.body.voiceAgentId.trim()) {
    updatePayload.voiceAgentId = req.body.voiceAgentId.trim()
  }

  if (
    !updatePayload.position &&
    !updatePayload.anim &&
    !updatePayload.posture &&
    updatePayload.workstationId === undefined &&
    updatePayload.voiceAgentId === undefined
  ) {
    return res.status(400).json({ success: false, message: 'No fields to persist' })
  }

  const namespaceSlug = namespaceSlugRaw || null
  let room: SkyOffice | undefined
  if (namespaceSlug) {
    room = SkyOffice.getRoomByNamespaceSlug(namespaceSlug)
  }
  if (!room) {
    room = SkyOffice.findRoomWithAgent(agentIdRaw)
  }
  if (!room) {
    room = SkyOffice.getAnyActiveRoom()
  }
  if (!room) {
    return res.status(503).json({ success: false, message: 'No active SkyOffice room' })
  }

  const result = room.updateNpcState(agentIdRaw, updatePayload)
  if (!result) {
    return res.status(404).json({ success: false, message: 'NPC not found in active rooms' })
  }

  res.json({
    success: true,
    agentId: agentIdRaw,
    namespaceSlug: namespaceSlug,
    position: result.assignment.position,
    assignment: result.assignment,
  })
})

const server = http.createServer(app)
const gameServer = new Server({
  server,
})

// register room handlers
gameServer.define(RoomType.LOBBY, LobbyRoom)
gameServer.define(RoomType.PUBLIC, SkyOffice, {
  name: 'Public Lobby',
  description: 'For making friends and familiarizing yourself with the controls',
  password: null,
  autoDispose: false,
})
gameServer.define(RoomType.CUSTOM, SkyOffice).enableRealtimeListing()

app.use('/colyseus', monitor())

gameServer.listen(port)
console.log(`Listening on ws://localhost:${port}`)

// 初始化数据库并基于 Registry 同步房间
initDb()

const REGISTRY_SYNC_INTERVAL_MS = Number(process.env.REGISTRY_SYNC_INTERVAL_MS || 60_000)
let registrySyncInFlight = false

const runRegistryEnsure = async () => {
  if (registrySyncInFlight) return
  registrySyncInFlight = true
  try {
    await ensureRegistryRooms()
  } catch (err) {
    console.error('[registry-sync] Unexpected error while ensuring registry rooms', err)
  } finally {
    registrySyncInFlight = false
  }
}

const bootstrapRegistrySync = async () => {
  try {
    clearAllRooms()
  } catch (err) {
    console.warn('[registry-sync] Failed to clear persisted room cache', err)
  }

  try {
    clearAllNpcs()
  } catch (err) {
    console.warn('[registry-sync] Failed to clear persisted NPC cache', err)
  }

  await runRegistryEnsure()
}

bootstrapRegistrySync().catch((err) => {
  console.error('[registry-sync] Failed during bootstrap sync', err)
})

setInterval(() => {
  runRegistryEnsure().catch((err) => {
    console.error('[registry-sync] Periodic ensure failed', err)
  })
}, REGISTRY_SYNC_INTERVAL_MS)
