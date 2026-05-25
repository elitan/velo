import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '#api/router';

export type ApiClient = RouterClient<AppRouter>;
export type ControlPlaneState = Awaited<ReturnType<ApiClient['dashboard']['retrieve']>>;

const link = new RPCLink({
  url: getApiUrl,
});

export const api: ApiClient = createORPCClient(link);
export const orpc = createTanstackQueryUtils(api);

function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    return new URL('/api/v1', window.location.origin).toString();
  }

  return process.env.VELO_API_URL || 'http://localhost:3000/api/v1';
}
