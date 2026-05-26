import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#web/components/ui/alert-dialog';
import { Badge } from '#web/components/ui/badge';
import { Button } from '#web/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#web/components/ui/card';
import { Input } from '#web/components/ui/input';
import { Label } from '#web/components/ui/label';
import { orpc } from '#web/lib/api-client';

export function ApiKeysPanel() {
  const queryClient = useQueryClient();
  const apiKeys = useQuery(orpc.apiKeys.list.queryOptions());
  const createToken = useMutation(orpc.apiKeys.create.mutationOptions({ onSuccess: refreshApiTokens }));
  const revokeToken = useMutation(orpc.apiKeys.revoke.mutationOptions({ onSuccess: refreshApiTokens }));
  const [name, setName] = useState('');
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<number | null>(null);

  async function refreshApiTokens() {
    await queryClient.invalidateQueries({ queryKey: orpc.apiKeys.list.key() });
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const result = await createToken.mutateAsync({ name });
      setCreatedToken(result.token);
      setName('');
      toast.success('API key created.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not create API key.');
    }
  }

  async function handleCopyToken() {
    if (!createdToken) {
      return;
    }

    await navigator.clipboard.writeText(createdToken);
    toast.success('Copied API key.');
  }

  async function handleRevoke() {
    const id = revokeId;
    setRevokeId(null);

    if (!id) {
      return;
    }

    try {
      await revokeToken.mutateAsync({ id });
      toast.success('API key revoked.');
    } catch (error: any) {
      toast.error(error?.message || 'Could not revoke API key.');
    }
  }

  const tokens = apiKeys.data || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>Bearer keys for `/api/v1`</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={handleCreate}>
          <div className="grid gap-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              value={name}
              placeholder="local dev"
              onChange={function updateApiKeyName(event) {
                setName(event.target.value);
              }}
            />
          </div>
          <Button type="submit" className="self-end" disabled={createToken.isPending || !name.trim()}>
            {createToken.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Create
          </Button>
        </form>

        {createdToken ? (
          <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
            <Label htmlFor="new-api-key">New API key</Label>
            <div className="flex min-w-0 gap-2">
              <Input id="new-api-key" readOnly value={createdToken} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="icon" onClick={handleCopyToken} aria-label="Copy API key">
                <Copy />
              </Button>
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          {apiKeys.isLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading API keys
            </div>
          ) : tokens.length === 0 ? (
            <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
              No API keys.
            </div>
          ) : (
            tokens.map(function renderToken(token) {
              return (
                <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={token.id}>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-sm font-medium">{token.name}</p>
                      <Badge variant={token.revokedAt ? 'secondary' : 'outline'}>
                        {token.revokedAt ? 'revoked' : 'active'}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {token.tokenPrefix}...
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Last used {token.lastUsedAt ? formatLastUsed(token.lastUsedAt) : 'never'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={Boolean(token.revokedAt) || revokeToken.isPending}
                    onClick={function openRevokeToken() {
                      setRevokeId(token.id);
                    }}
                  >
                    <Trash2 />
                    Revoke
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </CardContent>

      <AlertDialog
        open={revokeId !== null}
        onOpenChange={function changeRevokeOpen(open) {
          if (!open) {
            setRevokeId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>This key will stop working.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeToken.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revokeToken.isPending} onClick={handleRevoke}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function formatLastUsed(value: string): string {
  return new Date(value).toLocaleString();
}
