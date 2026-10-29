import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

const migrationFilePattern = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export function runMigrations(database: DatabaseSync, directory: string): void {
  const migrations = loadMigrations(directory);

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database.prepare(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  ).all();
  const applied = new Map<number, AppliedMigration>();
  for (const row of appliedRows) {
    const migration = parseAppliedMigration(row);
    applied.set(migration.version, migration);
  }

  for (const existing of applied.values()) {
    const source = migrations.find((migration) => migration.version === existing.version);
    if (!source) {
      throw new Error(`Applied migration ${existing.version} is missing from ${directory}`);
    }
    if (source.name !== existing.name || source.checksum !== existing.checksum) {
      throw new Error(`Applied migration ${existing.version} was modified`);
    }
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function loadMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const match = migrationFilePattern.exec(entry.name);
      if (!match) {
        if (entry.name.toLowerCase().endsWith('.sql')) {
          throw new Error(`Invalid migration filename ${entry.name}`);
        }
        return [];
      }
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`Invalid migration version in ${entry.name}`);
      }
      const sql = readFileSync(join(directory, entry.name), 'utf8').replaceAll('\r\n', '\n');
      return [{
        version,
        name: entry.name,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      }];
    })
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) {
    throw new Error(`No SQL migrations found in ${directory}`);
  }

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

function parseAppliedMigration(row: Record<string, unknown>): AppliedMigration {
  if (
    typeof row.version !== 'number'
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.name !== 'string'
    || typeof row.checksum !== 'string'
  ) {
    throw new Error('Invalid schema_migrations row');
  }
  return {
    version: row.version,
    name: row.name,
    checksum: row.checksum,
  };
}
