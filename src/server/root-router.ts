import { router } from './trpc';
import { setupRouter } from './routers/setup-router';

export const appRouter = router({
  setup: setupRouter,
});

export type AppRouter = typeof appRouter;
