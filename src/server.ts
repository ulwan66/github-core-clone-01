// The HTTP server: routing, bearer authentication, request ids, and the JSON
// envelope every surface shares. Bodies are read as bytes and interpreted per
// route — JSON for REST and GraphQL, raw for git and MCP — and a handler that
// throws answers 500 JSON without ever taking the server down.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { ApiResponse } from './rest.ts';
import type { Store } from './store.ts';

export interface ForgeServerOptions {
  /**
   * The bearer token to require. When empty, any non-empty bearer token is
   * accepted (local development); a missing token is always refused.
   */
  expectedToken: string;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body exceeds the size limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

function sendJson(response: ServerResponse, requestId: string, answer: ApiResponse): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': requestId,
    ...(answer.headers ?? {}),
  };
  const body = answer.json === null ? '' : JSON.stringify(answer.json);
  response.writeHead(answer.status, headers);
  response.end(body);
}

export function createForgeServer(store: Store, options: ForgeServerOptions): Server {
  let requestCounter = 0;

  const server = createServer(async (request, response) => {
    requestCounter += 1;
    const requestId = `forge-${requestCounter}`;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = decodeSegments(url.pathname);
      if (segments === null) {
        sendJson(response, requestId, { status: 400, json: { message: 'malformed path' } });
        return;
      }
      const method = request.method ?? 'GET';

      // Health: no authentication, answered before anything else.
      if (segments.length === 1 && segments[0] === 'healthz') {
        if (method !== 'GET') {
          sendJson(response, requestId, { status: 404, json: { message: 'Not Found' } });
          return;
        }
        sendJson(response, requestId, { status: 200, json: { ok: true } });
        return;
      }

      const isRest = segments[0] === 'api' && segments[1] === 'v3';
      const isGraphql = segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql';
      const isMcp = segments.length === 1 && segments[0] === 'mcp';
      const isGit =
        segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git');
      if (!isRest && !isGraphql && !isMcp && !isGit) {
        sendJson(response, requestId, { status: 404, json: { message: 'Not Found' } });
        return;
      }

      // Authentication: every known surface requires the bearer token.
      const authorization = request.headers.authorization ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      const authenticated =
        presented !== '' && (options.expectedToken === '' || presented === options.expectedToken);
      if (!authenticated) {
        sendJson(response, requestId, { status: 401, json: { message: 'Bad credentials' } });
        return;
      }

      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const rawBody = hasBody ? await readBody(request) : Buffer.alloc(0);

      if (isRest) {
        let parsed: unknown;
        if (rawBody.length === 0) {
          parsed = undefined;
        } else {
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(response, requestId, { status: 400, json: { message: 'Problems parsing JSON' } });
            return;
          }
        }
        const host = request.headers.host ?? '127.0.0.1';
        const origin = `http://${host}`;
        const answer = handleRest(store, segments.slice(2), method, url.searchParams, parsed, origin, url.pathname);
        sendJson(response, requestId, answer);
        return;
      }

      if (isGraphql) {
        let parsed: unknown;
        if (rawBody.length === 0) {
          parsed = undefined;
        } else {
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(response, requestId, {
              status: 400,
              json: { errors: [{ message: 'request body is not valid JSON' }] },
            });
            return;
          }
        }
        const answer = handleGraphql(store, parsed, method);
        sendJson(response, requestId, answer);
        return;
      }

      if (isMcp) {
        const answer = handleMcp(store, method, rawBody);
        sendJson(response, requestId, answer);
        return;
      }

      // Git smart HTTP.
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendJson(response, requestId, { status: 404, json: { message: 'Not Found' } });
        return;
      }
      const gitAnswer = handleGit(store, repo, segments.slice(2), method, url.searchParams, request.headers, rawBody);
      response.writeHead(gitAnswer.status, {
        ...gitAnswer.headers,
        'X-GitHub-Request-Id': requestId,
      });
      response.end(gitAnswer.body);
    } catch (err) {
      console.error(`[forge] request failed: ${(err as Error).message}`);
      if (!response.headersSent) {
        sendJson(response, requestId, { status: 500, json: { message: 'Internal Server Error' } });
      } else {
        response.end();
      }
    }
  });

  server.on('clientError', (err, socket) => {
    console.error(`[forge] client error: ${err.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"message":"Bad Request"}');
  });

  return server;
}
