import { Pool, type PoolConfig } from 'pg';

import type { DatabaseConfig } from '../config/env.js';

export type DatabaseCheck = () => Promise<void>;

export function createDatabasePool(config: DatabaseConfig): Pool {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
  };
  const pool = new Pool(poolConfig);

  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error', error);
  });

  return pool;
}

export async function checkDatabaseConnection(
  pool: Pick<Pool, 'query'>,
): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDatabase(pool: Pick<Pool, 'end'>): Promise<void> {
  await pool.end();
}
