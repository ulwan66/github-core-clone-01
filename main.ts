// Trial entrypoint. The lifecycle the harness expects: bind an ephemeral port,
// register it with the environment service, then poll until the environment
// says the trial is done. Nothing here serves traffic except the forge itself;
// the server answers /healthz from the moment it listens.

import type { AddressInfo } from 'node:net';
import { createForgeServer } from './src/server.ts';
import { VIEWER } from './src/scenario.ts';
import { Store } from './src/store.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}${REGISTER_PATH}`;
  const deadline = Date.now() + 30_000;
  let delay = 250;
  for (;;) {
    try {
      const status = await postJson(url, { port }, 10_000);
      if (status === 200 || status === 409) return;
      if (status === 400 || status === 405) {
        throw new Error(`register refused with status ${status}`);
      }
      // Any other status: retry while the budget lasts.
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // Network errors and timeouts: retry while the budget lasts.
    }
    if (Date.now() >= deadline) throw new Error('register did not succeed within 30 seconds');
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitUntilDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}${DONE_PATH}`;
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const payload = (await response.json()) as { done?: unknown };
      if (payload.done === true) return;
    } catch (err) {
      console.error(`[forge] done poll failed: ${(err as Error).message}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('[forge] MAKEFUN_ENV_URL is not set; refusing to start');
    process.exit(1);
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(VIEWER);
  const server = createForgeServer(store, { expectedToken: token });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  console.error(`[forge] listening on 127.0.0.1:${address.port} as ${VIEWER.login}`);
  try {
    await register(envUrl, address.port);
    await waitUntilDone(envUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await main();
