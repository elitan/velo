import type { ComponentType } from 'react';
import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';

type ApiReferenceComponent = ComponentType<{
  configuration: Record<string, unknown>;
}>;

export const Route = createFileRoute('/api-reference')({
  component: ApiReferencePage,
});

function ApiReferencePage() {
  const [ApiReference, setApiReference] = useState<ApiReferenceComponent | null>(null);

  useEffect(function loadApiReference() {
    let active = true;

    void Promise.all([
      import('@scalar/api-reference-react'),
      import('@scalar/api-reference-react/style.css'),
    ]).then(function setLoadedApiReference([module]) {
      if (!active) {
        return;
      }

      setApiReference(function storeApiReference() {
        return module.ApiReferenceReact as ApiReferenceComponent;
      });
    });

    return function cancelLoadApiReference() {
      active = false;
    };
  }, []);

  if (!ApiReference) {
    return <ApiReferenceLoading />;
  }

  return (
    <ApiReference
      configuration={{
        url: '/api/v1/openapi.json',
        theme: 'kepler',
        hideModels: false,
        hideDownloadButton: false,
        defaultHttpClient: {
          targetKey: 'js',
          clientKey: 'fetch',
        },
      }}
    />
  );
}

function ApiReferenceLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        Loading API reference...
      </div>
    </main>
  );
}
