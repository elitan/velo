export interface AuthState {
  configured: boolean;
  authenticated: boolean;
}

export async function getAuthState(): Promise<AuthState> {
  const response = await fetch('/api/auth/state', {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Could not load auth state.');
  }

  return response.json() as Promise<AuthState>;
}

export async function setupAuth(password: string): Promise<void> {
  await postAuth('/api/auth/setup', { password });
}

export async function login(password: string): Promise<void> {
  await postAuth('/api/auth/login', { password });
}

export async function logout(): Promise<void> {
  await postAuth('/api/auth/logout', {});
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await postAuth('/api/auth/password', { currentPassword, newPassword });
}

async function postAuth(url: string, body: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await readError(response);
    throw new Error(error);
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };

    return body.error || 'Request failed.';
  } catch {
    return 'Request failed.';
  }
}
