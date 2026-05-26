import { describe, expect, test } from 'bun:test';
import { OPEN_API_TAG_DEFINITIONS, OPEN_API_TAGS } from '../api/openapi-tags';
import { handleApiRequest } from '../web/routes/api/v1/$';
import { setPassword } from './auth';
import { createApiToken } from './services/api-token-service';
import { createAuditJob } from './services/job-service';
import { setSetting } from './services/settings-service';
import { createBranchRecord, createProject, useTestDatabase } from './test-helpers';

type OpenApiOperation = {
  tags?: string[];
};

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  tags?: Array<{ name: string }>;
};

const OPEN_API_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const EXPECTED_REST_PATHS = [
  '/api-keys',
  '/api-keys/{id}',
  '/backup/settings',
  '/branch-previews/{id}',
  '/branches',
  '/branches/{branchId}/sql',
  '/branches/{branchId}/tables',
  '/branches/{branchId}/tables/{database}/{schema}/{table}/rows',
  '/branches/{branchId}/tables/{database}/{schema}/{table}/rows/{rowId}',
  '/branches/{slug}',
  '/branches/{slug}/expiry',
  '/branches/{slug}/reset',
  '/branches/{sourceBranch}/previews',
  '/branches/{targetBranch}/restore',
  '/dashboard',
  '/jobs',
  '/jobs/{id}',
  '/jobs/{id}/cancel',
  '/jobs/{id}/retry',
  '/servers/{role}',
  '/servers/{role}/check',
  '/updates',
  '/updates/apply',
  '/updates/auto',
  '/updates/check',
  '/updates/result',
];

const EXPECTED_OPEN_API_TAGS = OPEN_API_TAG_DEFINITIONS.map(function mapTagDefinition(tag) {
  return tag.name;
});

useTestDatabase('velo-api-routes-');

describe('REST API routes', function restApiRoutes() {
  test('serves REST routes with bearer auth and grouped OpenAPI docs', async function testOpenApiBearerAuth() {
    await setPassword('password123');
    const created = await createApiToken('ci');
    const job = await createAuditJob('api-test', { ok: true }, 'api test');
    const projectId = await createProject();
    await setSetting('prod.connectionUrl', 'postgresql://postgres:prod@example.com:5432/postgres');
    await createBranchRecord({
      projectId,
      slug: 'dev',
      displayName: 'dev',
      dataset: 'prod.dev',
      port: 41001,
      connectionUrl: 'postgresql://postgres:dev@example.com:41001/postgres',
    });

    const unauthorized = await apiRequest('/branches');
    const authorized = await apiRequest('/branches', created.token);
    const specResponse = await apiRequest('/openapi.json', created.token);
    const apiKeysResponse = await apiRequest('/api-keys', created.token);
    const dashboardResponse = await apiRequest('/dashboard', created.token);
    const jobsResponse = await apiRequest('/jobs?limit=1&type=api-test', created.token);
    const jobResponse = await apiRequest(`/jobs/${job.id}`, created.token);
    const body = (await authorized.json()) as {
      branches: Array<{ slug: string; connectionString: string | null }>;
    };
    const spec = (await specResponse.json()) as OpenApiDocument;
    const apiKeys = (await apiKeysResponse.json()) as Array<{ id: number }>;
    const dashboard = (await dashboardResponse.json()) as {
      branches: unknown[];
    };
    const jobs = (await jobsResponse.json()) as Array<{ id: number }>;
    const retrievedJob = (await jobResponse.json()) as { id: number };

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(specResponse.status).toBe(200);
    expect(apiKeysResponse.status).toBe(200);
    expect(dashboardResponse.status).toBe(200);
    expect(jobsResponse.status).toBe(200);
    expect(jobResponse.status).toBe(200);
    expect(
      body.branches.map(function mapBranch(branch) {
        return branch.slug;
      }),
    ).toEqual(['production', 'dev']);
    expect(body.branches[1]?.connectionString).toBe('postgresql://postgres:dev@example.com:41001/postgres');
    expect(
      apiKeys.map(function mapKey(key) {
        return key.id;
      }),
    ).toContain(created.apiToken.id);
    expect(dashboard.branches).toHaveLength(1);
    expect(jobs[0]?.id).toBe(job.id);
    expect(retrievedJob.id).toBe(job.id);
    expect(
      EXPECTED_REST_PATHS.every(function hasPath(path) {
        return Boolean(spec.paths[path]);
      }),
    ).toBe(true);
    expect(getOpenApiTagNames(spec)).toEqual(EXPECTED_OPEN_API_TAGS);
    expect(getUntaggedOperations(spec)).toEqual([]);
    expect(spec.paths['/branches']?.get?.tags).toEqual([OPEN_API_TAGS.branches]);
    expect(spec.paths['/branches/{targetBranch}/restore']?.post?.tags).toEqual([OPEN_API_TAGS.recovery]);
    expect(spec.paths['/branches/{branchId}/tables']?.get?.tags).toEqual([OPEN_API_TAGS.data]);
    expect(spec.paths['/api-keys']?.get?.tags).toEqual([OPEN_API_TAGS.apiKeys]);
  });
});

function apiRequest(path: string, token?: string): Promise<Response> {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;

  return handleApiRequest(
    {
      request: new Request(`http://example.com/api/v1${path}`, { headers }),
    },
    { startDevJobWorker: false },
  );
}

function getOpenApiTagNames(spec: OpenApiDocument): string[] | undefined {
  return spec.tags?.map(function mapTag(tag) {
    return tag.name;
  });
}

function getUntaggedOperations(spec: OpenApiDocument): string[] {
  return Object.entries(spec.paths).flatMap(function mapPath([path, operations]) {
    return Object.entries(operations).flatMap(function mapOperation([method, operation]) {
      if (!OPEN_API_METHODS.has(method) || operation.tags?.length) {
        return [];
      }

      return [`${method.toUpperCase()} ${path}`];
    });
  });
}
