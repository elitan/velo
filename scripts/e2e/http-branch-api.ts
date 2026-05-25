import { createApiToken } from '#server/services/api-token-service';

export interface HttpBranchApiTestOptions {
  runId: string;
  port: string;
  trackBranch: (slug: string) => void;
  untrackBranch: (slug: string) => void;
  assertBranchConnects: (slug: string) => Promise<void>;
  assertBranchMissing: (slug: string) => Promise<void>;
}

export async function testHttpBranchApi(options: HttpBranchApiTestOptions): Promise<void> {
  const { token } = await createApiToken(`e2e ${options.runId}`);
  const branchName = `e2e_http_${options.runId}`;
  const created = await apiFetch<{ branch: { slug: string }; connectionUri: string }>(options, '/branches', token, {
    method: 'POST',
    body: JSON.stringify({ name: branchName }),
  });
  options.trackBranch(created.branch.slug);

  assert(created.branch.slug === branchName, 'HTTP create should return branch slug');
  assert(created.connectionUri.startsWith('postgresql://'), 'HTTP create should return connection URI');
  await options.assertBranchConnects(created.branch.slug);

  const listed = await apiFetch<{ branches: Array<{ slug: string }> }>(options, '/branches', token);
  assert(listed.branches.some(function hasBranch(branch) {
    return branch.slug === created.branch.slug;
  }), 'HTTP list should include created branch');

  const retrieved = await apiFetch<{ branch: { slug: string; connectionUri: string } }>(options, `/branches/${created.branch.slug}`, token);
  assert(retrieved.branch.connectionUri === created.connectionUri, 'HTTP retrieve should return connection URI');

  await apiFetch(options, `/branches/${created.branch.slug}`, token, { method: 'DELETE' });
  options.untrackBranch(created.branch.slug);
  await options.assertBranchMissing(created.branch.slug);
}

async function apiFetch<T = unknown>(
  options: HttpBranchApiTestOptions,
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${options.port}/api/v1${path}`, {
    ...init,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
