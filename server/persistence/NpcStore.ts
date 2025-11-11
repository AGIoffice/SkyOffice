import { getDb } from './db'

export interface PersistedNpc {
  agentId: string
  registryAgentId?: string | null
  officeId?: string | null
  name: string
  avatarId: string
  workstationId: string
  positionX: number
  positionY: number
  role?: string | null
  computerId?: string | null
  roomName?: string | null
  voiceAgentId?: string | null
  namespaceSlug?: string | null
  agentMetadata?: Record<string, unknown> | null
}

const OPTIONAL_COLUMNS = [
  'voiceAgentId TEXT',
  'namespaceSlug TEXT',
  'registryAgentId TEXT',
  'officeId TEXT',
  'agentMetadata TEXT',
]

function ensureNpcTable() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS npcs (
      agentId TEXT PRIMARY KEY,
      registryAgentId TEXT,
      officeId TEXT,
      name TEXT NOT NULL,
      avatarId TEXT NOT NULL,
      workstationId TEXT NOT NULL,
      positionX REAL NOT NULL,
      positionY REAL NOT NULL,
      role TEXT,
      computerId TEXT,
      roomName TEXT,
      voiceAgentId TEXT,
      namespaceSlug TEXT,
      agentMetadata TEXT
    );
  `)

  for (const column of OPTIONAL_COLUMNS) {
    try {
      db.exec(`ALTER TABLE npcs ADD COLUMN ${column}`)
    } catch {
      /* column already exists */
    }
  }

  return db
}

export function saveNpc(npc: PersistedNpc) {
  if (!npc.agentId) return
  const db = ensureNpcTable()
  const metadataJson =
    npc.agentMetadata && Object.keys(npc.agentMetadata).length > 0
      ? JSON.stringify(npc.agentMetadata)
      : null

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO npcs 
    (agentId, registryAgentId, officeId, name, avatarId, workstationId, positionX, positionY, role, computerId, roomName, voiceAgentId, namespaceSlug, agentMetadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    npc.agentId,
    npc.registryAgentId ?? null,
    npc.officeId ?? null,
    npc.name,
    npc.avatarId,
    npc.workstationId,
    npc.positionX,
    npc.positionY,
    npc.role ?? null,
    npc.computerId ?? null,
    npc.roomName ?? null,
    npc.voiceAgentId ?? null,
    npc.namespaceSlug ?? null,
    metadataJson
  )
}

type NpcRow = {
  agentId: string
  registryAgentId?: string | null
  officeId?: string | null
  name: string
  avatarId: string
  workstationId: string
  positionX: number
  positionY: number
  role?: string | null
  computerId?: string | null
  roomName?: string | null
  voiceAgentId?: string | null
  namespaceSlug?: string | null
  agentMetadata?: string | null
}

export function allNpcs(): PersistedNpc[] {
  const db = ensureNpcTable()
  const stmt = db.prepare('SELECT * FROM npcs')
  const rows = stmt.all() as NpcRow[]
  return rows.map((row: NpcRow) => {
    let metadata: Record<string, unknown> | null = null
    if (typeof row.agentMetadata === 'string' && row.agentMetadata.trim()) {
      try {
        metadata = JSON.parse(row.agentMetadata)
      } catch {
        metadata = null
      }
    }

    return {
      agentId: row.agentId,
      registryAgentId: row.registryAgentId ?? null,
      officeId: row.officeId ?? null,
      name: row.name,
      avatarId: row.avatarId,
      workstationId: row.workstationId,
      positionX: Number(row.positionX) || 0,
      positionY: Number(row.positionY) || 0,
      role: row.role ?? null,
      computerId: row.computerId ?? null,
      roomName: row.roomName ?? null,
      voiceAgentId: row.voiceAgentId ?? null,
      namespaceSlug: row.namespaceSlug ?? null,
      agentMetadata: metadata,
    }
  })
}

export function removeNpc(agentId: string) {
  if (!agentId) return
  const db = ensureNpcTable()
  db.prepare('DELETE FROM npcs WHERE agentId = ?').run(agentId)
}

export function clearAllNpcs() {
  const db = ensureNpcTable()
  db.prepare('DELETE FROM npcs').run()
}
