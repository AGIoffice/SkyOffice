declare module 'better-sqlite3' {
  interface BetterSqlite3Constructor {
    new (filename: string, options?: Record<string, unknown>): any
  }

  const Database: BetterSqlite3Constructor
  export default Database
}
