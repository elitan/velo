import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
  useLocation,
  useNavigate,
} from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { Toaster } from '#web/components/ui/sonner';
import { getAuthState, type AuthState } from '#web/lib/auth-client';
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
        <AuthGate>
          <Outlet />
        </AuthGate>
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

function AuthGate(props: Readonly<{ children: ReactNode }>) {
  const location = useLocation();
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const pathname = location.pathname;
  const isPublic = pathname === '/login' || pathname === '/setup';

  useEffect(function loadAuthState() {
    let active = true;

    getAuthState()
      .then(function setLoadedAuthState(nextAuth) {
        if (active) {
          setAuth(nextAuth);
        }
      })
      .catch(function setFailedAuthState() {
        if (active) {
          setAuth({ configured: false, authenticated: false });
        }
      });

    return function cancelLoadAuthState() {
      active = false;
    };
  }, [pathname]);

  useEffect(function redirectForAuthState() {
    if (!auth) {
      return;
    }

    if (!auth.configured && pathname !== '/setup') {
      void navigate({ to: '/setup', replace: true });
      return;
    }

    if (auth.configured && auth.authenticated && isPublic) {
      void navigate({ to: '/', replace: true });
      return;
    }

    if (auth.configured && !auth.authenticated && !isPublic) {
      void navigate({ to: '/login', search: { next: pathname }, replace: true });
    }
  }, [auth, isPublic, navigate, pathname]);

  if (!auth) {
    return <RootLoading />;
  }

  if (!auth.configured && pathname !== '/setup') {
    return <RootLoading />;
  }

  if (auth.configured && !auth.authenticated && !isPublic) {
    return <RootLoading />;
  }

  return props.children;
}

function RootLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        Loading...
      </div>
    </main>
  );
}
