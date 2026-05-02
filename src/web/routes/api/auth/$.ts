import { createFileRoute } from '@tanstack/react-router';
import { auth } from '#server/auth';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
    },
  },
});

async function handleAuthRequest(context: { request: Request }) {
  return auth.handler(context.request);
}
