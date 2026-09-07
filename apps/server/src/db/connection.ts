import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

export function openSqlite(filename: string): SqliteDatabase {
  const database = new Database(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  return database;
}
