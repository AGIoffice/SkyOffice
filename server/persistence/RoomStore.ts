import { getDb } from './db'

export interface PersistedRoom {
  name: string
  description: string
  password: string | null
  autoDispose: boolean
}

function ensureTable() {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      password TEXT,
      autoDispose INTEGER NOT NULL
    );
  `)
  return db
}

export function saveRoom(room: PersistedRoom) {
  const db = ensureTable()
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO rooms (name, description, password, autoDispose)
    VALUES (@name, @description, @password, @autoDispose)
  `)
  stmt.run({ ...room, autoDispose: room.autoDispose ? 1 : 0 })
}

export function allRooms(): PersistedRoom[] {
  const db = ensureTable()
  const rows = db.prepare(`SELECT name, description, password, autoDispose FROM rooms`).all()
  return rows.map((row) => ({
    name: row.name,
    description: row.description,
    password: row.password ?? null,
    autoDispose: !!row.autoDispose,
  }))
}

export function deleteRoomByName(name: string) {
  if (!name) return
  const db = ensureTable()
  db.prepare(`DELETE FROM rooms WHERE name = ?`).run(name)
}

export function clearAllRooms() {
  const db = ensureTable()
  db.prepare(`DELETE FROM rooms`).run()
}
