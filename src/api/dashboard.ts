import { publicProcedure } from './context';
import { OPEN_API_TAGS } from './openapi-tags';
import { getControlPlaneState } from '#server/services/setup-state-service';

export const dashboardRouter = {
  retrieve: publicProcedure
    .route({ method: 'GET', path: '/dashboard', summary: 'Get dashboard state', tags: [OPEN_API_TAGS.dashboard] })
    .handler(async function retrieveDashboard() {
      return getControlPlaneState();
    }),
};
