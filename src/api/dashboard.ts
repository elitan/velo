import { publicProcedure } from './context';
import { OPEN_API_TAGS } from './openapi-tags';
import { getControlPlaneState } from '#server/services/setup-state-service';

export const dashboardRouter = publicProcedure.tag(OPEN_API_TAGS.dashboard).router({
  retrieve: publicProcedure
    .route({
      method: 'GET',
      path: '/dashboard',
      summary: 'Get dashboard state',
    })
    .handler(async function retrieveDashboard() {
      return getControlPlaneState();
    }),
});
