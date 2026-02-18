/**
 * @module mcp/db
 * Readonly SQLite connection for the MCP server.
 */

import Database from "better-sqlite3";

/**
 * Open a readonly SQLite connection with WAL journal mode.
 * Registers a SIGTERM handler to close the connection gracefully.
 *
 * @param dbPath - Absolute path to the SQLite database file
 * @returns The better-sqlite3 Database instance in readonly mode
 */
export function openReadonlyDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });

  return db;
}
