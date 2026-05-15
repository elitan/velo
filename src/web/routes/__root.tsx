import type { ReactNode } from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router';
import { Toaster } from '#web/components/ui/sonner';
import '../styles.css';

export const Route = createRootRoute({
  head: function head() {
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#181818' },
        { title: 'Velo' },
      ],
    };
  },
  component: RootComponent,
});

function RootComponent() {
  const [queryClient] = useState(function createRootQueryClient() {
    return new QueryClient();
  });

  return (
    <QueryClientProvider client={queryClient}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </QueryClientProvider>
  );
}

function RootDocument(props: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark style-mira theme-zinc theme-inter">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}
