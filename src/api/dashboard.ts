import { publicProcedure } from './context';
import { getControlPlaneState } from '#server/services/setup-state-service';

export const dashboardRouter = {
  retrieve: publicProcedure
    .route({ method: 'GET', path: '/dashboard', summary: 'Get dashboard state' })
    .handler(async function retrieveDashboard() {
      return getControlPlaneState();
    }),
};
