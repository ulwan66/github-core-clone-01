// Standalone runner for local development, without the trial harness:
//   MAKEFUN_SHOP_TOKEN=dev-token node dev.ts 8081
// With no token set, any non-empty bearer token is accepted.

import { createForgeServer } from './src/server.ts';
import { VIEWER } from './src/scenario.ts';
import { Store } from './src/store.ts';

const port = Number.parseInt(process.argv[2] ?? '8080', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: node dev.ts [port]');
  process.exit(1);
}
const token = process.env.MAKEFUN_SHOP_TOKEN ?? process.argv[3] ?? '';
const store = new Store(VIEWER);
const server = createForgeServer(store, { expectedToken: token });
server.listen(port, '127.0.0.1', () => {
  console.error(`[forge] listening on http://127.0.0.1:${port} as ${VIEWER.login}`);
});
