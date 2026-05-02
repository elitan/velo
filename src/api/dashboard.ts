import { publicProcedure } from './context';
import { getControlPlaneState } from '#server/services/setup-state-service';

export const dashboardRouter = {
  retrieve: publicProcedure.handler(async function retrieveDashboard() {
    return getControlPlaneState();
  }),
};
