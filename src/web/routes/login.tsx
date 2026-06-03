import { createFileRoute, useSearch } from '@tanstack/react-router';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '#web/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#web/components/ui/card';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { login } from '#web/lib/auth-client';
import { getMutationErrorMessage } from '#web/lib/errors';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const search = useSearch({ from: '/login' }) as { next?: string };
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);

    try {
      await login(password);
      window.location.assign(safeNextPath(search.next));
    } catch (error: any) {
      toast.error(getMutationErrorMessage(error, 'Could not sign in.'));
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Enter the Velo password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={function updatePassword(event) {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthPage>
  );
}

function AuthPage(props: Readonly<{ children: ReactNode }>) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      {props.children}
    </main>
  );
}

function safeNextPath(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }

  return next;
}
