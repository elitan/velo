import { createServer } from 'node:net';

export async function getAvailableTcpPort(preferredPort?: number | null): Promise<number> {
  if (preferredPort) {
    await assertTcpPortAvailable(preferredPort);
    return preferredPort;
  }

  return listenForPort(0);
}

async function assertTcpPortAvailable(port: number): Promise<void> {
  await listenForPort(port);
}

async function listenForPort(port: number): Promise<number> {
  const server = createServer();

  return new Promise<number>(function resolvePort(resolve, reject) {
    server.once('error', function handleListenError(error) {
      reject(error);
    });

    server.listen(port, '127.0.0.1', function handleListen() {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;

      server.close(function closeServer(error) {
        if (error) {
          reject(error);
          return;
        }

        resolve(resolvedPort);
      });
    });
  });
}
