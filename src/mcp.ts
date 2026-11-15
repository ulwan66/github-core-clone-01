// The MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as
// plain JSON. It speaks the 2026-07-28 revision through `server/discover`,
// keeps the legacy `initialize` handshake for older clients, and exposes six
// tools over the same store the REST surface uses. The tool list is built once
// at load time, so repeated `tools/list` calls answer byte-identically.

import { createIssueRecord, createPullRecord, issueJson, mergePullRequest, pullJson, repoJson } from './domain.ts';
import { Store } from './store.ts';
import type { ApiResponse } from './rest.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

function resultEnvelope(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorEnvelope(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function firstString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(args[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function asPullNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

class ToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/** Run one tool. Throws ToolCallError for argument problems (-32602); returns an isError result for domain failures. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = firstString(args, 'name', 'repo', 'repository');
      if (repoName === undefined || repoName === '') throw new ToolCallError('create_repo requires a name');
      const repo = store.createRepo(store.viewer.login, repoName, {
        description: asString(args.description),
        isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (repo === null) return toolError(`Repository "${repoName}" already exists`);
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const owner = firstString(args, 'owner');
      const repoName = firstString(args, 'repo', 'name');
      if (owner === undefined || repoName === undefined) throw new ToolCallError('get_repo requires owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository "${owner}/${repoName}" was not found`);
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const owner = firstString(args, 'owner');
      const repoName = firstString(args, 'repo', 'name');
      const title = firstString(args, 'title');
      if (owner === undefined || repoName === undefined || title === undefined) {
        throw new ToolCallError('create_issue requires owner, repo, and title');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository "${owner}/${repoName}" was not found`);
      const created = createIssueRecord(store, repo, { title, body: asString(args.body) });
      if ('error' in created) return toolError(created.error);
      return toolResult(issueJson(store, repo, created));
    }
    case 'list_issues': {
      const owner = firstString(args, 'owner');
      const repoName = firstString(args, 'repo', 'name');
      if (owner === undefined || repoName === undefined) throw new ToolCallError('list_issues requires owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository "${owner}/${repoName}" was not found`);
      const state = asString(args.state) ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const owner = firstString(args, 'owner');
      const repoName = firstString(args, 'repo', 'name');
      const title = firstString(args, 'title');
      const head = firstString(args, 'head', 'headRef', 'head_branch', 'headRefName');
      const base = firstString(args, 'base', 'baseRef', 'base_branch', 'baseRefName');
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        throw new ToolCallError('create_pull_request requires owner, repo, title, head, and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository "${owner}/${repoName}" was not found`);
      const created = createPullRecord(store, repo, { title, body: asString(args.body), head, base });
      if ('error' in created) return toolError(created.error);
      return toolResult(pullJson(store, repo, created));
    }
    case 'merge_pull_request': {
      const owner = firstString(args, 'owner');
      const repoName = firstString(args, 'repo', 'name');
      const pullNumber = asPullNumber(args.pull_number ?? args.number ?? args.pullNumber);
      if (owner === undefined || repoName === undefined || pullNumber === undefined) {
        throw new ToolCallError('merge_pull_request requires owner, repo, and pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository "${owner}/${repoName}" was not found`);
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} was not found`);
      const outcome = mergePullRequest(store, repo, pull);
      if (!outcome.ok) {
        return toolError(outcome.reason === 'conflict' ? 'Merge conflict' : 'Pull request cannot be merged');
      }
      return toolResult(pullJson(store, repo, pull));
    }
    default:
      throw new ToolCallError(`unknown tool "${name}"`);
  }
}

function handleMessage(store: Store, message: unknown): Record<string, unknown> | null {
  const request = asRecord(message);
  if (request === null) return errorEnvelope(null, INVALID_REQUEST, 'request must be a JSON object');
  const hasId = 'id' in request;
  const id = (request.id as JsonRpcId | undefined) ?? null;
  const method = request.method;
  if (typeof method !== 'string') {
    if (!hasId) return null;
    return errorEnvelope(id, INVALID_REQUEST, 'method is required');
  }
  const params = asRecord(request.params) ?? {};

  const answer = (result: unknown): Record<string, unknown> | null =>
    hasId ? resultEnvelope(id, result) : null;
  const answerError = (code: number, text: string): Record<string, unknown> | null =>
    hasId ? errorEnvelope(id, code, text) : null;

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return answer({
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const offered = params.protocolVersion;
      const protocolVersion =
        typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return answer({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return answer({});
    case 'tools/list':
      return answer({ tools: TOOLS });
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string') return answerError(INVALID_PARAMS, 'tools/call requires a tool name');
      const toolArgs = asRecord(params.arguments) ?? {};
      try {
        return answer(callTool(store, toolName, toolArgs));
      } catch (err) {
        if (err instanceof ToolCallError) return answerError(INVALID_PARAMS, err.message);
        throw err;
      }
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return answerError(METHOD_NOT_FOUND, `method "${method}" is not supported`);
  }
}

export { LEGACY_VERSIONS };

/** Handle one /mcp request. Notifications answer 202 with an empty body. */
export function handleMcp(store: Store, method: string, rawBody: Buffer): ApiResponse {
  if (method !== 'POST') {
    return {
      status: 405,
      json: errorEnvelope(null, METHOD_NOT_FOUND, 'only POST is supported on /mcp'),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.length === 0 ? 'null' : rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      json: errorEnvelope(null, PARSE_ERROR, 'Parse error'),
    };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((message) => handleMessage(store, message))
      .filter((response) => response !== null);
    return { status: 200, json: responses };
  }
  const response = handleMessage(store, parsed);
  if (response === null) return { status: 202, json: null };
  return { status: 200, json: response };
}
