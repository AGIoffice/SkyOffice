import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const BetterSqlite3: any = Database as any
let db: any = null

export function initDb() {
  const dataDir = path.join(__dirname, '..', 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'rooms.db')

  db = new BetterSqlite3(dbPath)
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

export function getDb() {
  if (!db) return initDb()
  return db
}
