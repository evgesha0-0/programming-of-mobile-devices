import { loadEnv } from '../config/env.js';
import { createDatabasePool } from './connection.js';
import { runMigrations } from './migrations.js';

async function main(): Promise<void> {
  const pool = createDatabasePool(loadEnv().database);
  try {
    const connection = await pool.connect();
    try {
      const applied = await runMigrations(connection);
      console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // В ошибках подключения PostgreSQL могут оказаться значения конфигурации.
  console.error('Migration failed. Check database access and migration history.');
  if (error instanceof Error && error.message.startsWith('Migration history differs'))
    console.error(error.message);
  process.exitCode = 1;
});
