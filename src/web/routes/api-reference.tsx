import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import type { AnyApiReferenceConfiguration } from '@scalar/api-reference-react';

type ApiReferenceComponent = (typeof import('@scalar/api-reference-react'))['ApiReferenceReact'];

const API_REFERENCE_CONFIG: AnyApiReferenceConfiguration = {
  url: '/api/v1/openapi.json',
  theme: 'kepler',
  hideModels: false,
  hideDownloadButton: false,
  defaultHttpClient: {
    targetKey: 'js',
    clientKey: 'fetch',
  },
};

export const Route = createFileRoute('/api-reference')({
  component: ApiReferencePage,
});

function ApiReferencePage() {
  const [ApiReference, setApiReference] = useState<ApiReferenceComponent | null>(null);

  useEffect(function loadApiReference() {
    let active = true;

    void loadApiReferenceComponent().then(function setLoadedApiReference(Component) {
      if (!active) {
        return;
      }

      setApiReference(function storeApiReference() {
        return Component;
      });
    });

    return function cancelLoadApiReference() {
      active = false;
    };
  }, []);

  if (!ApiReference) {
    return <ApiReferenceLoading />;
  }

  return <ApiReference configuration={API_REFERENCE_CONFIG} />;
}

async function loadApiReferenceComponent(): Promise<ApiReferenceComponent> {
  const [module] = await Promise.all([
    import('@scalar/api-reference-react'),
    import('@scalar/api-reference-react/style.css'),
  ]);

  return module.ApiReferenceReact;
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
