import { migrateDatabase } from '../db/migrate';
import { closeDb } from '../db/client';
import { seedLocalDockerState } from './services/local-docker-service';

migrateDatabase();
await seedLocalDockerState();
await closeDb();

console.log('Local Docker state ready');
