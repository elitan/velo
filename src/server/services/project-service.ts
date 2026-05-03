import { sql } from 'kysely';
import { DEFAULTS } from '#config/defaults';
import { getDb } from '#db/client';
import type { Project } from '#db/schema';

const DEFAULT_PROJECT_NAME = 'prod';

export interface ProjectInput {
  name: string;
  postgresVersion?: string;
  databaseName?: string;
  appUser?: string;
}

export async function getCurrentProject(): Promise<Project | null> {
  const project = await getDb()
    .selectFrom('projects')
    .selectAll()
    .orderBy('id')
    .executeTakeFirst();

  return project ?? null;
}

export async function ensureProject(): Promise<Project> {
  const existing = await getCurrentProject();

  if (existing) {
    return existing;
  }

  await getDb()
    .insertInto('projects')
    .values({
      name: DEFAULT_PROJECT_NAME,
      postgresVersion: DEFAULTS.postgres.defaultVersion,
      databaseName: 'postgres',
      appUser: 'postgres',
    })
    .execute();

  return getDb()
    .selectFrom('projects')
    .selectAll()
    .orderBy('id')
    .executeTakeFirstOrThrow();
}

export async function saveProject(input: ProjectInput): Promise<Project> {
  const name = input.name.trim();
  const postgresVersion = (input.postgresVersion || DEFAULTS.postgres.defaultVersion).trim();
  const databaseName = (input.databaseName || 'postgres').trim();
  const appUser = (input.appUser || 'postgres').trim();

  if (!name) {
    throw new Error('Project name is required');
  }

  const existing = await getCurrentProject();

  if (existing) {
    await getDb()
      .updateTable('projects')
      .set({
        name,
        postgresVersion,
        databaseName,
        appUser,
        updatedAt: sql`datetime('now')`,
      })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await getDb()
      .insertInto('projects')
      .values({
        name,
        postgresVersion,
        databaseName,
        appUser,
      })
      .execute();
  }

  await setProjectStepDone();

  return getDb()
    .selectFrom('projects')
    .selectAll()
    .orderBy('id')
    .executeTakeFirstOrThrow();
}

async function setProjectStepDone(): Promise<void> {
  await getDb()
    .updateTable('setupSteps')
    .set({
      status: 'done',
      message: 'project saved',
      updatedAt: sql`datetime('now')`,
    })
    .where('key', '=', 'project')
    .execute();
}
