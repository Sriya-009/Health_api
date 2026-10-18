import 'dotenv/config';
import { closeDb, initDb } from './db.js';

try {
  await initDb();
  console.log('SQLite database is ready.');
  await closeDb();
} catch (error) {
  console.error('Database setup failed:', error.message);
  process.exitCode = 1;
}
