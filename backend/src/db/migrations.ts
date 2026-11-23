import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function loadMigrations(directory = new URL('../../migrations/', import.meta.url)): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const versions = new Set<string>();
  const migrations: Migration[] = [];
  for (const name of names) {
    if (!/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name) || name.startsWith('000_'))
      throw new Error(`Invalid migration filename: ${name}`);
    const version = name.slice(0, 3);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    // Checkout Windows не должен менять контрольную сумму SQL из-за CRLF.
    const sql = (await readFile(new URL(name, directory), 'utf8')).replaceAll('\r\n', '\n');
    migrations.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  if (migrations.length === 0) throw new Error('No SQL migrations found');
  return migrations;
}

export async function runMigrations(
  connection: MigrationConnection,
  migrations?: readonly Migration[],
): Promise<string[]> {
  const sources = migrations ?? await loadMigrations();
  await connection.query('BEGIN');
  try {
    await connection.query("SET LOCAL lock_timeout = '10s'");
    // Один и тот же ключ используют все экземпляры приложения в этой БД.
    await connection.query('SELECT pg_advisory_xact_lock(5456710, 1)');
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await connection.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (let index = 0; index < history.rows.length; index++) {
      const applied = history.rows[index]!;
      const source = sources[index];
      if (!source || source.name !== applied.name || source.checksum !== applied.checksum)
        throw new Error(`Migration history differs from source: ${String(applied.name)}`);
    }
    const applied: string[] = [];
    for (const migration of sources.slice(history.rows.length)) {
      await connection.query(migration.sql);
      await connection.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum]);
      applied.push(migration.name);
    }
    await connection.query('COMMIT');
    return applied;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
