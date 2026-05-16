import { createFileRoute } from '@tanstack/react-router';
import {
  clearSessionCookie,
  createSession,
  getAuthState,
  isAuthenticated,
  sessionCookie,
  setPassword,
  setupPassword,
  verifyPassword,
} from '#server/auth';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: handleAuthRequest,
      POST: handleAuthRequest,
    },
  },
});

async function handleAuthRequest(context: { request: Request }) {
  const url = new URL(context.request.url);
  const action = url.pathname.replace(/^\/api\/auth\/?/, '') || 'state';

  if (context.request.method === 'GET' && action === 'state') {
    return Response.json(await getAuthState(context.request));
  }

  if (context.request.method !== 'POST') {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }

  if (action === 'setup') {
    return handleSetup(context.request);
  }

  if (action === 'login') {
    return handleLogin(context.request);
  }

  if (action === 'logout') {
    return Response.json({ ok: true }, {
      headers: {
        'Set-Cookie': clearSessionCookie(),
      },
    });
  }

  if (action === 'password') {
    return handlePasswordChange(context.request);
  }

  return Response.json({ error: 'Not found.' }, { status: 404 });
}

async function handleSetup(request: Request): Promise<Response> {
  const { password } = await readPasswordBody(request);

  try {
    const token = await setupPassword(password);

    return Response.json({ ok: true }, {
      headers: {
        'Set-Cookie': sessionCookie(token),
      },
    });
  } catch (error) {
    return authError(error, 409);
  }
}

async function handleLogin(request: Request): Promise<Response> {
  const { password } = await readPasswordBody(request);
  const token = await createSession(password);

  if (!token) {
    return Response.json({ error: 'Wrong password.' }, { status: 401 });
  }

  return Response.json({ ok: true }, {
    headers: {
      'Set-Cookie': sessionCookie(token),
    },
  });
}

async function handlePasswordChange(request: Request): Promise<Response> {
  if (!(await isAuthenticated(request))) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await readJsonBody(request);
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!(await verifyPassword(currentPassword))) {
    return Response.json({ error: 'Current password is wrong.' }, { status: 401 });
  }

  try {
    const token = await setPassword(newPassword);

    return Response.json({ ok: true }, {
      headers: {
        'Set-Cookie': sessionCookie(token),
      },
    });
  } catch (error) {
    return authError(error, 400);
  }
}

async function readPasswordBody(request: Request): Promise<{ password: string }> {
  const body = await readJsonBody(request);

  return {
    password: String(body.password || ''),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function authError(error: unknown, status: number): Response {
  return Response.json({
    error: error instanceof Error ? error.message : String(error),
  }, { status });
}
