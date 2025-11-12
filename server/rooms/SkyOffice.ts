import bcrypt from 'bcrypt'
import { Room, Client, ServerError, matchMaker, updateLobby } from 'colyseus'
import * as RawMatchMaker from '@colyseus/core/build/MatchMaker'
import { Dispatcher } from '@colyseus/command'
import { Player, OfficeState, Computer, Whiteboard } from './schema/OfficeState'
import { Message } from '../../types/Messages'
import { IRoomData } from '../../types/Rooms'
import { whiteboardRoomIds } from './schema/OfficeState'
import { resolveComputerIdFromWorkstation } from '../../../shared/workstationSeats'
import { saveNpc, allNpcs, PersistedNpc, removeNpc as removeNpcPersist } from '../persistence/NpcStore'
import { patchRegistryAgent, patchRegistryOffice } from '../services/registryApi'

const normaliseNpcRole = (role?: string): string => {
  if (!role) return 'GM'
  const trimmed = role.trim()
  if (!trimmed) return 'GM'
  if (trimmed.toLowerCase() === 'office secretary') return 'GM'
  return trimmed
}

interface NpcDeploymentPayload {
  agentId: string
  registryAgentId?: string | null
  name: string
  avatarId: string
  workstationId: string
  position: { x: number; y: number }
  role?: string
  officeId?: string
  computerId?: string
  voiceAgentId?: string
  namespaceSlug?: string
  agentMetadata?: Record<string, unknown> | null
}

interface NpcAssignment extends NpcDeploymentPayload {
  roomId: string
  assignedAt: string
  computerId?: string
}

interface NpcUpsertOptions {
  skipPersistence?: boolean
  skipRegistrySync?: boolean
}
import PlayerUpdateCommand from './commands/PlayerUpdateCommand'
import PlayerUpdateNameCommand from './commands/PlayerUpdateNameCommand'
import {
  ComputerAddUserCommand,
  ComputerRemoveUserCommand,
} from './commands/ComputerUpdateArrayCommand'
import {
  WhiteboardAddUserCommand,
  WhiteboardRemoveUserCommand,
} from './commands/WhiteboardUpdateArrayCommand'
import ChatMessageUpdateCommand from './commands/ChatMessageUpdateCommand'
import { saveRoom, deleteRoomByName } from '../persistence/RoomStore'
import { verifyManagerToken, ManagerTokenPayload } from '../lib/managerToken'
import { resolvePresenceSecret } from '../services/presenceSecret'

export class SkyOffice extends Room<OfficeState> {
  private static activeRooms: Map<string, SkyOffice> = new Map()
  private static namespaceRooms: Map<string, SkyOffice> = new Map()
  private static readonly avatarAnimMap: Record<string, string> = {
    adam: 'adam_idle_down',
    ash: 'ash_idle_down',
    lucy: 'lucy_idle_down',
    nancy: 'nancy_idle_down',
  }
  private dispatcher = new Dispatcher(this)
  private name: string
  private description: string
  private password: string | null = null
  private npcAssignments = new Map<string, NpcAssignment>()
  private namespaceSlug?: string
  private customDomain?: string
  private roomMetadata: Record<string, unknown> = {}
  private registryOfficeId?: string | null


  private static getNpcKey(agentId: string): string {
    return `npc-${agentId}`
  }

  async onCreate(options: IRoomData) {
    const { name, description } = options
    const autoDisposeOpt = (options as any).autoDispose
    const passwordOpt = (options as any).password
    const passwordHashOpt = (options as any).passwordHash as string | null | undefined
    const namespaceSlug = (options as any).namespaceSlug as string | undefined
    const metadataOpt = (options as any).metadata as Record<string, unknown> | undefined

    const resolvedNamespace = (namespaceSlug && namespaceSlug.trim()) || name

    this.name = name
    const resolvedDescription =
      typeof description === 'string' && description.trim().length
        ? description.trim()
        : `${name} workspace`
    this.description = resolvedDescription
    this.autoDispose = autoDisposeOpt ?? false
    this.namespaceSlug = resolvedNamespace.trim().toLowerCase()
    this.customDomain = (metadataOpt?.customDomain as string | undefined) || undefined

    let hasPassword = false
    if (passwordHashOpt) {
      // 从持久化恢复的哈希
      this.password = passwordHashOpt
      hasPassword = true
    } else if (passwordOpt) {
      const salt = await bcrypt.genSalt(10)
      this.password = await bcrypt.hash(passwordOpt as string, salt)
      hasPassword = true
    }

    const metadataPayload: Record<string, unknown> = {
      name,
      description: this.description,
      hasPassword,
    }

    const namespaceKey = resolvedNamespace.trim().toLowerCase()
    metadataPayload.namespaceSlug = namespaceKey

    if (metadataOpt && typeof metadataOpt === 'object') {
      Object.assign(metadataPayload, metadataOpt)
    }

    if (!metadataPayload.displayName) {
      metadataPayload.displayName = name
    }

    this.roomMetadata = metadataPayload
    const registryOfficeId =
      typeof metadataPayload.registryOfficeId === 'string' && metadataPayload.registryOfficeId.trim()
        ? metadataPayload.registryOfficeId.trim()
        : null
    this.registryOfficeId = registryOfficeId
    metadataPayload.activeRoomId = this.roomId
    this.setMetadata(metadataPayload)
    this.setState(new OfficeState())
    SkyOffice.activeRooms.set(this.roomId, this)
    if (this.namespaceSlug) {
      SkyOffice.namespaceRooms.set(this.namespaceSlug, this)
    }

    if (registryOfficeId) {
      patchRegistryOffice(registryOfficeId, { skyofficeWorldId: this.roomId }).catch((err: unknown) => {
        console.warn('[skyoffice] failed to update registry room mapping', registryOfficeId, this.roomId, err)
      })
    }

    // 持久化房间元数据（存储哈希后的密码）
    saveRoom({
      name: this.name,
      description: this.description,
      password: this.password,
      autoDispose: !!this.autoDispose,
    })

    // HARD-CODED: Add 5 computers in a room
    for (let i = 0; i < 5; i++) {
      this.state.computers.set(String(i), new Computer())
    }

    // HARD-CODED: Add 3 whiteboards in a room
    for (let i = 0; i < 3; i++) {
      this.state.whiteboards.set(String(i), new Whiteboard())
    }

    // when a player connect to a computer, add to the computer connectedUser array
    this.onMessage(Message.CONNECT_TO_COMPUTER, (client, message: { computerId: string }) => {
      this.dispatcher.dispatch(new ComputerAddUserCommand(), {
        client,
        computerId: message.computerId,
      })
    })

    // when a player disconnect from a computer, remove from the computer connectedUser array
    this.onMessage(Message.DISCONNECT_FROM_COMPUTER, (client, message: { computerId: string }) => {
      this.dispatcher.dispatch(new ComputerRemoveUserCommand(), {
        client,
        computerId: message.computerId,
      })
    })

    // when a player stop sharing screen
    this.onMessage(Message.STOP_SCREEN_SHARE, (client, message: { computerId: string }) => {
      const computer = this.state.computers.get(message.computerId)
      computer.connectedUser.forEach((id) => {
        this.clients.forEach((cli) => {
          if (cli.sessionId === id && cli.sessionId !== client.sessionId) {
            cli.send(Message.STOP_SCREEN_SHARE, client.sessionId)
          }
        })
      })
    })

    // when a player connect to a whiteboard, add to the whiteboard connectedUser array
    this.onMessage(Message.CONNECT_TO_WHITEBOARD, (client, message: { whiteboardId: string }) => {
      this.dispatcher.dispatch(new WhiteboardAddUserCommand(), {
        client,
        whiteboardId: message.whiteboardId,
      })
    })

    // when a player disconnect from a whiteboard, remove from the whiteboard connectedUser array
    this.onMessage(
      Message.DISCONNECT_FROM_WHITEBOARD,
      (client, message: { whiteboardId: string }) => {
        this.dispatcher.dispatch(new WhiteboardRemoveUserCommand(), {
          client,
          whiteboardId: message.whiteboardId,
        })
      }
    )

    // when receiving updatePlayer message, call the PlayerUpdateCommand
    this.onMessage(
      Message.UPDATE_PLAYER,
      (client, message: { x: number; y: number; anim: string }) => {
        this.dispatcher.dispatch(new PlayerUpdateCommand(), {
          client,
          x: message.x,
          y: message.y,
          anim: message.anim,
        })
      }
    )

    // when receiving updatePlayerName message, call the PlayerUpdateNameCommand
    this.onMessage(Message.UPDATE_PLAYER_NAME, (client, message: { name: string }) => {
      this.dispatcher.dispatch(new PlayerUpdateNameCommand(), {
        client,
        name: message.name,
      })
    })

    // when a player is ready to connect, call the PlayerReadyToConnectCommand
    this.onMessage(Message.READY_TO_CONNECT, (client) => {
      const player = this.state.players.get(client.sessionId)
      if (player) player.readyToConnect = true
    })

    // when a player is ready to connect, call the PlayerReadyToConnectCommand
    this.onMessage(Message.VIDEO_CONNECTED, (client) => {
      const player = this.state.players.get(client.sessionId)
      if (player) player.videoConnected = true
    })

    // when a player disconnect a stream, broadcast the signal to the other player connected to the stream
    this.onMessage(Message.DISCONNECT_STREAM, (client, message: { clientId: string }) => {
      this.clients.forEach((cli) => {
        if (cli.sessionId === message.clientId) {
          cli.send(Message.DISCONNECT_STREAM, client.sessionId)
        }
      })
    })

    // when a player send a chat message, update the message array and broadcast to all connected clients except the sender
    this.onMessage(Message.ADD_CHAT_MESSAGE, (client, message: { content: string }) => {
      // update the message array (so that players join later can also see the message)
      this.dispatcher.dispatch(new ChatMessageUpdateCommand(), {
        client,
        content: message.content,
      })

      // broadcast to all currently connected clients except the sender (to render in-game dialog on top of the character)
      this.broadcast(
        Message.ADD_CHAT_MESSAGE,
        { clientId: client.sessionId, content: message.content },
        { except: client }
      )
    })
  }

  public static getRoomById(roomId: string): SkyOffice | undefined {
    return this.activeRooms.get(roomId)
  }

  public static getActiveRoomCount(): number {
    return this.activeRooms.size
  }

  public static getAnyActiveRoom(): SkyOffice | undefined {
    const iterator = this.activeRooms.values().next()
    return iterator.value
  }

  public static listNpcAssignments(): NpcAssignment[] {
    const assignments: NpcAssignment[] = []
    this.activeRooms.forEach((room) => {
      assignments.push(...room.getNpcAssignments())
    })
    return assignments
  }

  public static findRoomWithAgent(agentId: string): SkyOffice | undefined {
    let matchedRoom: SkyOffice | undefined
    this.activeRooms.forEach((room) => {
      if (matchedRoom) return
      if (room.getNpcAssignments().some((assignment) => assignment.agentId === agentId)) {
        matchedRoom = room
      }
    })
    return matchedRoom
  }

  public static async pruneNamespacesNotIn(validNamespaces: Set<string>) {
    if (!(validNamespaces instanceof Set)) return
    const normalized = new Set(
      Array.from(validNamespaces)
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean)
    )

    const toRemove: string[] = []
    this.namespaceRooms.forEach((room, slug) => {
      const normalizedSlug = (slug || '').trim().toLowerCase()
      if (!normalizedSlug) return
      if (!room.isRegistryBacked()) return
      if (normalized.has(normalizedSlug)) return
      const head = normalizedSlug.split('.')[0]
      if (head && normalized.has(head)) return
      toRemove.push(normalizedSlug)
    })

    for (const slug of toRemove) {
      try {
        await this.destroyNamespace(slug)
      } catch (err) {
        console.warn('[skyoffice] Failed to prune namespace during registry reconcile', slug, err)
      }
    }
  }

  public static removeNpcEverywhere(agentId: string): boolean {
    let removed = false
    this.activeRooms.forEach((room) => {
      const did = room.removeNpc(agentId)
      if (did) removed = true
    })
    return removed
  }

  public static async destroyNamespace(namespaceSlug: string) {
    const raw = namespaceSlug?.trim().toLowerCase()
    if (!raw) {
      return { removedRooms: [] as string[], removedAgents: [] as string[] }
    }

    const slugCandidates = new Set<string>()
    slugCandidates.add(raw)
    if (raw.includes('.')) {
      const [first] = raw.split('.')
      if (first) slugCandidates.add(first)
    } else {
      const base = (process.env.OFFICE_BASE_DOMAIN || 'office.xyz').trim().toLowerCase()
      if (base) {
        slugCandidates.add(`${raw}.${base}`)
      }
    }

    const removedRooms: string[] = []
    const removedAgents = new Set<string>()

    for (const slug of slugCandidates) {
      const activeRoom = this.namespaceRooms.get(slug)
      if (activeRoom) {
        activeRoom
          .getNpcAssignments()
          .filter((npc) => {
            const npcSlug = (npc.namespaceSlug || npc.roomId || slug).toLowerCase()
            return slugCandidates.has(npcSlug) || slugCandidates.has(npcSlug.split('.')[0])
          })
          .forEach((npc) => {
            const didRemove = activeRoom.removeNpc(npc.agentId)
            if (didRemove) {
              removedAgents.add(npc.agentId)
            }
          })

        try {
          await activeRoom.disconnect()
          removedRooms.push(activeRoom.roomId)
        } catch (err) {
          console.warn('[skyoffice] Failed to disconnect room during namespace teardown', slug, err)
        }
      }

      try {
        deleteRoomByName(slug)
      } catch (err) {
        console.warn('[skyoffice] Failed to delete persisted room entry', slug, err)
      }

      try {
        const listings = await matchMaker.query({ name: slug })
        this.removeListings(listings, slugCandidates, removedRooms)
      } catch (err) {
        console.warn('[skyoffice] Failed to query matchmaker listings', slug, err)
      }

      const rawDriver = (RawMatchMaker as any)?.driver
      if (rawDriver && typeof rawDriver.find === 'function') {
        try {
          const localListings = rawDriver.find({ name: slug }) || []
          this.removeListings(localListings, slugCandidates, removedRooms)
        } catch (err) {
          console.warn('[skyoffice] Failed to remove listings from driver', slug, err)
        }
      }

      this.namespaceRooms.delete(slug)
    }

    const persistedNpcs = allNpcs().filter((npc: PersistedNpc) => {
      const namespace = (npc.namespaceSlug || npc.roomName || '').toLowerCase()
      if (!namespace) return false
      if (slugCandidates.has(namespace)) return true
      const [first] = namespace.split('.')
      return first ? slugCandidates.has(first) : false
    })

    for (const npc of persistedNpcs) {
      try {
        this.removeNpcEverywhere(npc.agentId)
      } catch (err) {
        console.warn('[skyoffice] Failed to purge NPC from active rooms', npc.agentId, err)
      }

      try {
        removeNpcPersist(npc.agentId)
      } catch (err) {
        console.warn('[skyoffice] Failed to delete persisted NPC record', npc.agentId, err)
      }

      removedAgents.add(npc.agentId)
    }

    return { removedRooms, removedAgents: Array.from(removedAgents) }
  }

  private static removeListings(listings: any[], slugCandidates: Set<string>, removedRooms: string[]) {
    if (!Array.isArray(listings) || listings.length === 0) return
    listings.forEach((listing) => {
      const metadata = (listing?.metadata ?? {}) as Record<string, unknown>
      const candidateValues = new Set<string>()
      const pushCandidate = (value: unknown) => {
        if (typeof value !== 'string') return
        const trimmed = value.trim().toLowerCase()
        if (!trimmed) return
        candidateValues.add(trimmed)
        if (trimmed.includes('.')) {
          const [first] = trimmed.split('.')
          if (first) candidateValues.add(first)
        }
      }

      pushCandidate(metadata.namespaceSlug)
      pushCandidate(metadata.slug)
      pushCandidate(metadata.namespace)
      pushCandidate(metadata.domain)
      pushCandidate(metadata.registryDomain)
      pushCandidate(metadata.customDomain)
      pushCandidate(metadata.name)
      pushCandidate(listing?.name)

      const matchesMetadata = Array.from(candidateValues).some((value) => slugCandidates.has(value))
      const listingName = typeof listing?.name === 'string' ? listing.name.trim().toLowerCase() : ''
      const roomId = typeof listing?.roomId === 'string' ? listing.roomId.trim().toLowerCase() : ''
      const matchesDirect =
        (listingName && slugCandidates.has(listingName)) ||
        (roomId && slugCandidates.has(roomId)) ||
        (listingName && listingName.includes('.') && slugCandidates.has(listingName.split('.')[0])) ||
        (roomId && roomId.includes('.') && slugCandidates.has(roomId.split('.')[0]))

      if (!matchesMetadata && !matchesDirect) {
        return
      }

      if (typeof updateLobby === 'function') {
        try {
          updateLobby({ listing } as any, true)
        } catch (err) {
          console.warn('[skyoffice] Failed to publish lobby removal', listing?.roomId, err)
        }
      }

      if (typeof listing?.remove === 'function') {
        try {
          listing.remove()
        } catch (err) {
          console.warn('[skyoffice] Failed to remove matchmaker listing entry', listing?.roomId, err)
        }
      }

      if (listing?.roomId && !removedRooms.includes(listing.roomId)) {
        removedRooms.push(listing.roomId)
      }
    })
  }

  private static getIdleAnim(avatarId: string): string {
    return this.avatarAnimMap[avatarId] || 'adam_idle_down'
  }

  private static getSittingAnim(avatarId: string): string {
    return `${avatarId}_sit_down`
  }

  private assignNpcToWorkstation(playerKey: string, payload: NpcDeploymentPayload): string | undefined {
    const workstationId = payload.workstationId
    if (!workstationId) return undefined

    const computerId = payload.computerId || resolveComputerIdFromWorkstation(workstationId)
    if (!computerId) return undefined

    // Remove from any previous computer occupancy
    this.state.computers.forEach((computer) => {
      computer.connectedUser.forEach((sessionId) => {
        if (sessionId === playerKey) {
          computer.connectedUser.delete(sessionId)
        }
      })
    })

    const targetComputer = this.state.computers.get(computerId)
    if (!targetComputer) return undefined

    const alreadyConnected = targetComputer.connectedUser.has(playerKey)
    if (!alreadyConnected) {
      targetComputer.connectedUser.add(playerKey)
    }

    return computerId
  }

  public upsertNpc(payload: NpcDeploymentPayload, options: NpcUpsertOptions = {}): NpcAssignment {
    const key = SkyOffice.getNpcKey(payload.agentId)
    let player = this.state.players.get(key)
    if (!player) {
      player = new Player()
      this.state.players.set(key, player)
    }

    player.name = payload.name
    player.x = payload.position?.x ?? player.x
    player.y = payload.position?.y ?? player.y
    player.readyToConnect = true
    player.videoConnected = false

    const assignedComputerId = this.assignNpcToWorkstation(key, payload)
    
    // 如果 NPC 有工位，设置为坐着动画；否则设置为站立动画
    if (assignedComputerId || payload.computerId) {
      player.anim = SkyOffice.getSittingAnim(payload.avatarId)
    } else {
      player.anim = SkyOffice.getIdleAnim(payload.avatarId)
    }

    const npcRole = normaliseNpcRole(payload.role)

    const assignment: NpcAssignment = {
      ...payload,
      namespaceSlug: payload.namespaceSlug || this.namespaceSlug || this.name,
      officeId: payload.officeId,
      registryAgentId: payload.registryAgentId,
      agentMetadata: payload.agentMetadata,
      role: npcRole,
      roomId: this.roomId,
      assignedAt: new Date().toISOString(),
      computerId: assignedComputerId || payload.computerId,
    }

    this.npcAssignments.set(payload.agentId, assignment)
    
    if (!options.skipPersistence) {
      // 持久化保存 NPC 到数据库
      saveNpc({
        agentId: assignment.agentId,
        registryAgentId: assignment.registryAgentId || null,
        officeId: assignment.officeId || null,
        name: assignment.name,
        avatarId: assignment.avatarId,
        workstationId: assignment.workstationId,
        positionX: assignment.position?.x ?? player.x,
        positionY: assignment.position?.y ?? player.y,
        role: assignment.role,
        voiceAgentId: assignment.voiceAgentId || null,
        computerId: assignment.computerId || null,
        roomName: this.name,
        namespaceSlug: assignment.namespaceSlug || null,
        agentMetadata: assignment.agentMetadata || null,
      })
    }

    if (!options.skipRegistrySync) {
      this.syncNpcToRegistry(assignment)
    }

    this.updatePresenceMetadata()
    
    return assignment
  }

  private syncNpcToRegistry(assignment: NpcAssignment) {
    if (!assignment.officeId || !assignment.registryAgentId) return

    const positionX = assignment.position?.x ?? null
    const positionY = assignment.position?.y ?? null
    const existingMetadata =
      (assignment.agentMetadata && typeof assignment.agentMetadata === 'object'
        ? { ...assignment.agentMetadata }
        : {}) as Record<string, unknown>

    const existingSpawn =
      (existingMetadata.spawn && typeof existingMetadata.spawn === 'object'
        ? { ...(existingMetadata.spawn as Record<string, unknown>) }
        : {}) as Record<string, unknown>

    const spawnMetadata: Record<string, unknown> = {
      ...existingSpawn,
      position: {
        x: positionX,
        y: positionY,
      },
    }

    if (assignment.workstationId !== undefined) {
      spawnMetadata.workstationId = assignment.workstationId
    }
    if (assignment.voiceAgentId !== undefined) {
      spawnMetadata.voiceAgentId = assignment.voiceAgentId
    }

    const metadataPatch: Record<string, unknown> = {
      ...existingMetadata,
      lastSeenAt: assignment.assignedAt,
      positionX,
      positionY,
      workstationId: assignment.workstationId ?? null,
      voiceAgentId: assignment.voiceAgentId ?? null,
      namespaceSlug: assignment.namespaceSlug || this.namespaceSlug || null,
      spawn: spawnMetadata,
      isPresentInSkyOffice: true,
    }

    if (assignment.computerId !== undefined) {
      metadataPatch.computerId = assignment.computerId
    }

    assignment.agentMetadata = metadataPatch

    void patchRegistryAgent(assignment.officeId, assignment.registryAgentId, {
      lastSeenAt: assignment.assignedAt,
      metadata: metadataPatch,
    })
  }

  private syncNpcRemovalFromRegistry(assignment: NpcAssignment) {
    if (!assignment.officeId || !assignment.registryAgentId) return

    const nowIso = new Date().toISOString()
    const existingMetadata =
      (assignment.agentMetadata && typeof assignment.agentMetadata === 'object'
        ? { ...assignment.agentMetadata }
        : {}) as Record<string, unknown>

    const metadataWithoutSpawn = { ...existingMetadata }
    delete metadataWithoutSpawn.spawn

    const spawnMetadata: Record<string, unknown> = {
      position: null,
      workstationId: null,
      voiceAgentId: null,
    }

    const metadataPatch: Record<string, unknown> = {
      ...metadataWithoutSpawn,
      lastSeenAt: nowIso,
      positionX: null,
      positionY: null,
      workstationId: null,
      voiceAgentId: null,
      namespaceSlug: assignment.namespaceSlug || this.namespaceSlug || null,
      spawn: spawnMetadata,
      isPresentInSkyOffice: false,
    }

    assignment.agentMetadata = metadataPatch

    void patchRegistryAgent(assignment.officeId, assignment.registryAgentId, {
      lastSeenAt: nowIso,
      metadata: metadataPatch,
    })
  }

  public getNamespaceSlug(): string | undefined {
    return this.namespaceSlug
  }

  public getRoomName(): string {
    return this.name
  }

  public isRegistryBacked(): boolean {
    const metadata = this.roomMetadata || {}
    return Boolean(
      metadata.registryBacked ||
        metadata.registryOfficeId ||
        metadata.registryId ||
        metadata.registryDomain ||
        metadata.registryMetadata
    )
  }

  public getNpcAssignments(): NpcAssignment[] {
    return Array.from(this.npcAssignments.values())
  }

  public removeNpc(agentId: string): boolean {
    const key = SkyOffice.getNpcKey(agentId)
    const assignment = this.npcAssignments.get(agentId)
    const existed = this.npcAssignments.delete(agentId)

    // remove from players map
    if (this.state.players.has(key)) {
      this.state.players.delete(key)
    }

    // remove any computer occupancy
    this.state.computers.forEach((computer) => {
      if (computer.connectedUser.has(key)) {
        computer.connectedUser.delete(key)
      }
    })

    // remove persistence
    try {
      removeNpcPersist(agentId)
    } catch {}

    if (assignment) {
      this.syncNpcRemovalFromRegistry(assignment)
    }

    this.updatePresenceMetadata()

    return existed
  }

  public updateNpcState(
    agentId: string,
    update: {
      position?: { x: number; y: number }
      anim?: string
      posture?: 'sit' | 'stand' | 'wave' | string
      workstationId?: string
      voiceAgentId?: string
    }
  ): { assignment: NpcAssignment; player?: Player } | null {
    const key = SkyOffice.getNpcKey(agentId)
    const player = this.state.players.get(key)
    const assignment = this.npcAssignments.get(agentId)
    if (!assignment) {
      return null
    }

    const nowIso = new Date().toISOString()
    assignment.assignedAt = nowIso

    if (update.position) {
      assignment.position = { ...update.position }
      if (player) {
        player.x = update.position.x
        player.y = update.position.y
      }
    }

    if (update.anim) {
      if (player) {
        player.anim = update.anim
      }
    } else if (update.posture) {
      if (player) {
        const anim =
          update.posture === 'sit'
            ? SkyOffice.getSittingAnim(assignment.avatarId)
            : SkyOffice.getIdleAnim(assignment.avatarId)
        player.anim = anim
      }
    }

    if (update.workstationId !== undefined) {
      assignment.workstationId = update.workstationId
    }
    if (update.voiceAgentId !== undefined) {
      assignment.voiceAgentId = update.voiceAgentId
    }

    saveNpc({
      agentId: assignment.agentId,
      registryAgentId: assignment.registryAgentId || null,
      officeId: assignment.officeId || null,
      name: assignment.name,
      avatarId: assignment.avatarId,
      workstationId: assignment.workstationId,
      positionX: assignment.position?.x ?? player?.x ?? 0,
      positionY: assignment.position?.y ?? player?.y ?? 0,
      role: assignment.role,
      voiceAgentId: assignment.voiceAgentId || null,
      computerId: assignment.computerId || null,
      roomName: this.name,
      namespaceSlug: assignment.namespaceSlug || null,
      agentMetadata: assignment.agentMetadata || null,
    })

    this.syncNpcToRegistry(assignment)
    this.updatePresenceMetadata()

    return { assignment, player }
  }

  async onAuth(client: Client, options: any) {
    const requestedNamespace =
      (typeof options?.namespaceSlug === 'string' && options.namespaceSlug.trim().toLowerCase()) ||
      (typeof options?.name === 'string' && options.name.trim().toLowerCase()) ||
      null
    const currentNamespace = this.namespaceSlug ? this.namespaceSlug.trim().toLowerCase() : null
    if (requestedNamespace && currentNamespace && requestedNamespace !== currentNamespace) {
      throw new ServerError(403, 'Namespace mismatch')
    }
    if (this.password) {
      if (!options.password) {
        throw new ServerError(403, 'Password is required!')
      }
      const validPassword = await bcrypt.compare(options.password as string, this.password as string)
      if (!validPassword) {
        throw new ServerError(403, 'Password is incorrect!')
      }
    }
    await this.validateNpcHandshake(client, options)
    return true
  }

  onJoin(client: Client, options: any) {
    const npcKey = (client as unknown as { userData?: any })?.userData?.npcKey
    if (!npcKey) {
      this.state.players.set(client.sessionId, new Player())
    }
    client.send(Message.SEND_ROOM_DATA, {
      id: this.roomId,
      name: this.name,
      description: this.description,
      namespaceSlug: this.namespaceSlug,
      customDomain: this.customDomain,
      metadata: this.roomMetadata,
    })
    
    // 同步现有 NPC 到新连接的客户端
    this.syncNpcsToClient(client)

    this.updatePresenceMetadata()
  }

  private async validateNpcHandshake(client: Client, options: any) {
    const agentRaw =
      typeof options?.agentId === 'string' ? options.agentId.trim().toLowerCase() : ''
    if (!agentRaw) {
      const tokenCandidate =
        (typeof options?.auth?.managerToken === 'string' && options.auth.managerToken.trim()) ||
        (typeof options?.managerToken === 'string' && options.managerToken.trim()) ||
        ''
      if (tokenCandidate) {
        console.warn('[skyoffice] managerToken provided without agentId')
      }
      return
    }

    const token =
      (typeof options?.auth?.managerToken === 'string' && options.auth.managerToken.trim()) ||
      (typeof options?.managerToken === 'string' && options.managerToken.trim()) ||
      ''
    if (!token) {
      throw new ServerError(403, 'managerToken is required for NPC connections')
    }

    const expectedNamespace =
      (typeof options?.namespaceSlug === 'string' && options.namespaceSlug.trim()) ||
      this.namespaceSlug ||
      this.name

    const expectedNamespaceLower = expectedNamespace ? expectedNamespace.toLowerCase() : null
    const currentNamespaceLower = this.namespaceSlug ? this.namespaceSlug.toLowerCase() : null

    this.ensureNpcAssignmentsLoaded()
    let assignment = this.npcAssignments.get(agentRaw)
    if (!assignment) {
      this.ensureNpcAssignmentsLoaded(true)
      assignment = this.npcAssignments.get(agentRaw)
      if (!assignment) {
        if (
          expectedNamespaceLower &&
          currentNamespaceLower &&
          expectedNamespaceLower !== currentNamespaceLower
        ) {
          const targetRoom = SkyOffice.getRoomByNamespaceSlug(expectedNamespaceLower)
          if (targetRoom) {
            throw new ServerError(410, JSON.stringify({ roomId: targetRoom.roomId }))
          }
        }
        const availableAgents = Array.from(this.npcAssignments.keys())
        console.warn(
          `[presence] assignment not found for ${agentRaw}. Available NPC keys: ${availableAgents.join(', ') || 'none'}`
        )
        throw new ServerError(404, `NPC assignment not found for agent '${agentRaw}'`)
      }
    }

    const presenceSecretResult = await resolvePresenceSecret(
      agentRaw,
      assignment.officeId || undefined
    )
    const secretSource = presenceSecretResult?.source ?? 'registry'
    const secretToUse = presenceSecretResult?.secret
    if (!secretToUse) {
      throw new ServerError(503, 'Presence credential unavailable')
    }

    let payload: ManagerTokenPayload
    try {
      payload = verifyManagerToken(token, secretToUse)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid managerToken'
      throw new ServerError(403, `Invalid managerToken (${message})`)
    }

    if (payload.agentId && payload.agentId.trim().toLowerCase() !== agentRaw) {
      throw new ServerError(403, 'managerToken agent mismatch')
    }

    const payloadNamespace = (payload.namespace || payload.namespaceSlug || '') as string
    if (payloadNamespace) {
      const payloadNamespaceLower = payloadNamespace.trim().toLowerCase()
      if (expectedNamespaceLower && payloadNamespaceLower && payloadNamespaceLower !== expectedNamespaceLower) {
        throw new ServerError(403, 'managerToken namespace mismatch')
      }
    }

    if (
      expectedNamespaceLower &&
      assignment.namespaceSlug &&
      assignment.namespaceSlug.toLowerCase() !== expectedNamespaceLower
    ) {
      throw new ServerError(403, 'NPC namespace mismatch')
    }

    const userData = ((client as unknown as { userData?: any }).userData ??= {})
    userData.npcAgentId = agentRaw
    userData.npcKey = SkyOffice.getNpcKey(agentRaw)
    userData.managerTokenPayload = payload
    userData.presenceSecretSource = secretSource
  }

  // 同步现有 NPC 到客户端
  private syncNpcsToClient(client: Client) {
    this.ensureNpcAssignmentsLoaded()

    if (this.npcAssignments.size === 0) {
      console.log('[sync] No NPC assignments to sync')
      return
    }

    this.npcAssignments.forEach((assignment) => {
      const key = SkyOffice.getNpcKey(assignment.agentId)
      let player = this.state.players.get(key)

      if (!player) {
        player = new Player()
        this.state.players.set(key, player)
      }

      player.name = assignment.name
      player.x = assignment.position?.x ?? player.x
      player.y = assignment.position?.y ?? player.y
      player.readyToConnect = true
      player.videoConnected = false
      player.anim = assignment.computerId
        ? SkyOffice.getSittingAnim(assignment.avatarId)
        : SkyOffice.getIdleAnim(assignment.avatarId)

      const assignedComputer = this.assignNpcToWorkstation(key, assignment)
      if (assignedComputer && assignment.computerId !== assignedComputer) {
        assignment.computerId = assignedComputer
      }

      console.log(`[sync] Synced NPC '${assignment.name}' to client ${client.sessionId}`)
    })
  }

  private ensureNpcAssignmentsLoaded(force = false) {
    if (!force && this.npcAssignments.size > 0) return

    const npcs = allNpcs().filter((npc: PersistedNpc) => {
      const roomName = npc.roomName || 'Public Lobby'
      return roomName === this.name
    })

    npcs.forEach((npc: PersistedNpc) => {
      this.upsertNpc(
        {
          agentId: npc.agentId,
          registryAgentId: npc.registryAgentId ?? undefined,
          officeId: npc.officeId ?? undefined,
          name: npc.name,
          avatarId: npc.avatarId,
          workstationId: npc.workstationId,
          position: { x: npc.positionX, y: npc.positionY },
          role: npc.role ?? undefined,
          computerId: npc.computerId ?? undefined,
          voiceAgentId: npc.voiceAgentId ?? undefined,
          namespaceSlug: npc.namespaceSlug ?? undefined,
          agentMetadata: npc.agentMetadata ?? undefined,
        },
        { skipPersistence: true, skipRegistrySync: true }
      )
    })

    this.updatePresenceMetadata()
  }

  onLeave(client: Client, consented: boolean) {
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId)
    }
    this.state.computers.forEach((computer) => {
      if (computer.connectedUser.has(client.sessionId)) {
        computer.connectedUser.delete(client.sessionId)
      }
    })
    this.state.whiteboards.forEach((whiteboard) => {
      if (whiteboard.connectedUser.has(client.sessionId)) {
        whiteboard.connectedUser.delete(client.sessionId)
      }
    })

    this.updatePresenceMetadata()
  }

  onDispose() {
    this.state.whiteboards.forEach((whiteboard) => {
      if (whiteboardRoomIds.has(whiteboard.roomId)) whiteboardRoomIds.delete(whiteboard.roomId)
    })

    console.log('room', this.roomId, 'disposing...')
    this.dispatcher.stop()
    SkyOffice.activeRooms.delete(this.roomId)
    if (this.namespaceSlug) {
      const current = SkyOffice.namespaceRooms.get(this.namespaceSlug)
      if (current === this) {
        SkyOffice.namespaceRooms.delete(this.namespaceSlug)
      }
    }

  }

  private updatePresenceMetadata() {
    const metadata = { ...(this.roomMetadata || {}) }
    const clientsRef: any = (this as unknown as { clients?: any }).clients
    let clientCount = 0
    if (Array.isArray(clientsRef)) {
      clientCount = clientsRef.length
    } else if (clientsRef && typeof clientsRef.size === 'number') {
      clientCount = clientsRef.size
    }
    const npcCount = this.npcAssignments.size
    metadata.clientsOnlineCount = clientCount
    metadata.npcOnlineCount = npcCount
    metadata.totalOnlineCount = clientCount + npcCount
    this.roomMetadata = metadata
    this.setMetadata(metadata)
  }

  public static getRoomByNamespaceSlug(slug: string): SkyOffice | undefined {
    const key = slug.trim().toLowerCase()
    return this.namespaceRooms.get(key)
  }

  public static getNamespaceRoomInfo(slug: string):
    | { roomId: string; namespaceSlug?: string; name: string }
    | null
  {
    const room = this.getRoomByNamespaceSlug(slug)
    if (!room) return null
    return {
      roomId: room.roomId,
      namespaceSlug: room.namespaceSlug,
      name: room.name,
    }
  }
}
