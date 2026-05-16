import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '#web/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#web/components/ui/card';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { setupAuth } from '#web/lib/auth-client';

export const Route = createFileRoute('/setup')({
  component: SetupPage,
});

function SetupPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (password !== confirmPassword) {
      toast.error('Passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      await setupAuth(password);
      window.location.assign('/');
    } catch (error: any) {
      toast.error(error?.message || 'Could not set password.');
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Protect Velo</CardTitle>
          <CardDescription>Set one password for this install.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={function updatePassword(event) {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={function updateConfirmPassword(event) {
                  setConfirmPassword(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={busy || !password || !confirmPassword}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Save password
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
