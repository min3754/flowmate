/**
 * @module db/client
 * Database initialization with WAL mode and Drizzle migrations.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import path from "node:path";
import fs from "node:fs";

/** Drizzle ORM database instance typed with the FlowMate schema. */
export type FlowmateDb = BetterSQLite3Database<typeof schema>;

/**
 * Create a SQLite database connection with WAL journal mode and foreign keys enabled.
 * Creates the parent directory if it does not exist.
 *
 * @param dbPath - Absolute path to the SQLite database file
 * @returns The Drizzle ORM instance and the underlying better-sqlite3 handle
 */
export function createDb(dbPath: string): { db: FlowmateDb; sqlite: Database.Database } {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

/**
 * Apply pending Drizzle schema migrations.
 *
 * @param db - Drizzle ORM database instance
 * @param migrationsFolder - Path to the directory containing migration SQL files
 */
export function runMigrations(db: FlowmateDb, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
