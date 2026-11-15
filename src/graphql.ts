// The GraphQL v4 surface at /api/graphql: a small tokenizer, recursive-descent
// parser and executor for the query and mutation documents the suite sends.
// It is not a general GraphQL server — it covers queries, mutations, variables,
// aliases, inline fragments, input objects, lists and enums — and it answers
// unknown fields the way GraphQL does, with an error naming the field.

import { pullHasConflict, createIssueRecord, createPullRecord, mergePullRequest, pullFiles } from './domain.ts';
import { Store } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';
import type { ApiResponse } from './rest.ts';

// ---------------------------------------------------------------------------
// global ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= source.length) throw new GraphQLSyntaxError('unterminated string');
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\n') throw new GraphQLSyntaxError('string contains a newline');
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) throw new GraphQLSyntaxError('unterminated escape');
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (simple[esc] !== undefined) {
            value += simple[esc];
            j += 2;
          } else {
            throw new GraphQLSyntaxError(`bad escape \\${esc}`);
          }
          continue;
        }
        value += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) throw new GraphQLSyntaxError(`bad number at offset ${i}`);
      const text = match[0];
      i += text.length;
      if (text.includes('.') || /[eE]/.test(text)) tokens.push({ kind: 'float', value: Number.parseFloat(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected "${value}", got ${describeToken(token)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected a name, got ${describeToken(token)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new GraphQLSyntaxError('document is empty');
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      const keyword = this.next();
      operation = (keyword as { kind: 'name'; value: string }).value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName.kind === 'name') name = this.expectName();
    } else if (token.kind === 'name' && token.value === 'subscription') {
      throw new GraphQLSyntaxError('subscriptions are not supported');
    }
    const variables = this.matchPunct('(') ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const definitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.matchPunct(')')) return definitions;
    for (;;) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      definitions.push({ name, defaultValue });
      if (this.matchPunct(')')) break;
    }
    return definitions;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.matchPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next.kind === 'punct' && next.value === '{') {
        this.skipDirectives();
        return { kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() };
      }
      throw new GraphQLSyntaxError('named fragment spreads are not supported');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.matchPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selection =
      this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{'
        ? this.parseSelectionSet()
        : null;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct(')')) return args;
    for (;;) {
      const name = this.expectName();
      this.expectPunct(':');
      const value = this.parseValue();
      args.push({ name, value });
      if (this.matchPunct(')')) break;
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`unexpected value token ${describeToken(token)}`);
  }
}

function describeToken(token: Token): string {
  if (token.kind === 'eof') return 'end of input';
  return `${token.kind} ${JSON.stringify(token.value)}`;
}

// ---------------------------------------------------------------------------
// executor

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

type GqlObject = Record<string, unknown> & { __gqlType: string };

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function valueFromNode(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!(node.name in ctx.variables) || ctx.variables[node.name] === undefined) return undefined;
      return ctx.variables[node.name];
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueFromNode(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, ctx);
      return out;
    }
  }
}

function argsFromNodes(nodes: ReadonlyArray<{ name: string; value: ValueNode }>, ctx: Ctx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of nodes) args[arg.name] = valueFromNode(arg.value, ctx);
  return args;
}

const SCHEMA: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'files',
  ],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestFilesConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestFile: ['path'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: SCHEMA.Issue!,
  PullRequest: SCHEMA.PullRequest!,
  Repository: SCHEMA.Repository!,
  User: SCHEMA.User!,
  Query: SCHEMA.Query!,
  Mutation: SCHEMA.Mutation!,
  Ref: SCHEMA.Ref!,
  PageInfo: SCHEMA.PageInfo!,
  IssueConnection: SCHEMA.IssueConnection!,
  PullRequestConnection: SCHEMA.PullRequestConnection!,
  IssueComment: SCHEMA.IssueComment!,
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function userNode(store: Store): GqlObject {
  const viewer = store.viewer;
  return { __gqlType: 'User', login: viewer.login, id: gid('User', viewer.id), name: viewer.name, email: viewer.email };
}

function issueNode(store: Store, repo: Repo, issue: Issue): GqlObject {
  return {
    __gqlType: 'Issue',
    __repo: repo,
    __issue: issue,
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): GqlObject {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  const mergeable =
    pull.state !== 'open' ? 'UNKNOWN' : pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __gqlType: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    mergeable,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
  };
}

function repoNode(store: Store, repo: Repo): GqlObject {
  return {
    __gqlType: 'Repository',
    __repo: repo,
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(store),
    defaultBranchRef: { __gqlType: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

/** Opaque pagination cursors: base64 of `cursor:<creation sequence>`. */
function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

/** Slice an ordered list into a connection page after an optional cursor. */
function paginateNodes<T extends { createdSeq: number }>(
  ordered: readonly T[],
  args: Record<string, unknown>,
  buildNode: (item: T) => GqlObject,
  connectionType: string,
): GqlObject {
  const afterSeq = decodeCursor(args.after);
  let start = 0;
  if (afterSeq !== null) {
    const index = ordered.findIndex((item) => item.createdSeq === afterSeq);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : ordered.length;
  const page = ordered.slice(start, start + first);
  const hasNextPage = start + page.length < ordered.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.createdSeq) : null;
  return {
    __gqlType: connectionType,
    nodes: page.map(buildNode),
    pageInfo: {
      __gqlType: 'PageInfo',
      hasNextPage,
      endCursor,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(page[0]!.createdSeq) : null,
    },
  };
}

type Resolver = (source: GqlObject, args: Record<string, unknown>, ctx: Ctx) => unknown;

function findRepoById(store: Store, databaseId: number): Repo | undefined {
  return store.listRepos().find((repo) => repo.id === databaseId);
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: (_source, _args, ctx) => userNode(ctx.store),
    repository: (_source, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoNode(ctx.store, repo);
    },
    node: (_source, args, ctx) => {
      const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
        return repo === undefined ? null : repoNode(ctx.store, repo);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
        if (repo === undefined) return null;
        const number = Number.parseInt(decoded.parts[1] ?? '', 10);
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueNode(ctx.store, repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullNode(ctx.store, repo, pull);
      }
      return null;
    },
    __type: (_source, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const fields = TYPE_FIELDS[name];
      const enumValues = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      return {
        __gqlType: '__Type',
        name,
        __fields: fields ?? [],
        __enumValues: enumValues ?? [],
      };
    },
  },
  Repository: {
    issue: (source, args, ctx) => {
      const repo = source.__repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(ctx.store, repo, issue);
    },
    issues: (source, args, ctx) => {
      const repo = source.__repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const direction = orderBy !== undefined && typeof orderBy === 'object' ? String(orderBy.direction ?? 'ASC') : 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
      return paginateNodes(issues, args, (issue) => issueNode(ctx.store, repo, issue), 'IssueConnection');
    },
    pullRequests: (source, args, ctx) => {
      const repo = source.__repo as Repo;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
      return paginateNodes(pulls, args, (pull) => pullNode(ctx.store, repo, pull), 'PullRequestConnection');
    },
    pullRequest: (source, args, ctx) => {
      const repo = source.__repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(ctx.store, repo, pull);
    },
  },
  PullRequest: {
    files: (source, args) => {
      const repo = source.__repo as Repo;
      const pull = source.__pull as Pull;
      const diffs = pullFiles(repo, pull).map((diff, index) => ({
        createdSeq: index + 1,
        path: diff.filename,
      }));
      return paginateNodes(
        diffs,
        args,
        (diff) => ({ __gqlType: 'PullRequestFile', path: diff.path }),
        'PullRequestFilesConnection',
      );
    },
  },
  __Type: {
    fields: (source) => (source.__fields as string[]).map((name) => ({ __gqlType: '__Field', name })),
    enumValues: (source) =>
      (source.__enumValues as string[]).map((name) => ({ __gqlType: '__EnumValue', name })),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new GraphQLError('createIssue requires an input object');
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('repositoryId does not name a repository');
      const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = createIssueRecord(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      if ('error' in created) throw new GraphQLError(created.error);
      return { __gqlType: 'CreateIssuePayload', issue: issueNode(ctx.store, repo, created) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new GraphQLError('closeIssue requires an input object');
      const decoded = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new GraphQLError('issueId does not name an issue');
      const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      issue.state = 'closed';
      issue.updatedSeq = ctx.store.tick();
      return { __gqlType: 'CloseIssuePayload', issue: issueNode(ctx.store, repo, issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new GraphQLError('createPullRequest requires an input object');
      const decoded = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('repositoryId does not name a repository');
      const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
      if (repo === undefined) throw new GraphQLError('repository not found');
      const created = createPullRecord(ctx.store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : undefined,
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if ('error' in created) throw new GraphQLError(created.error);
      return { __gqlType: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.store, repo, created) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new GraphQLError('mergePullRequest requires an input object');
      const decoded = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PullRequest') throw new GraphQLError('pullRequestId does not name a pull request');
      const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
      const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || pull === undefined) throw new GraphQLError('pull request not found');
      const outcome = mergePullRequest(ctx.store, repo, pull);
      if (!outcome.ok) throw new GraphQLError(outcome.reason === 'conflict' ? 'Merge conflict' : 'Pull request cannot be merged');
      return { __gqlType: 'MergePullRequestPayload', pullRequest: pullNode(ctx.store, repo, pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = args.input as Record<string, unknown> | undefined;
      if (input === undefined || typeof input !== 'object') throw new GraphQLError('addComment requires an input object');
      const decoded = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'Issue') throw new GraphQLError('subjectId does not name an issue');
      const repo = findRepoById(ctx.store, Number.parseInt(decoded.parts[0] ?? '', 10));
      const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
      if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: ctx.store.nextId(), body, createdSeq: ctx.store.tick() };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return {
        __gqlType: 'AddCommentPayload',
        commentEdge: {
          __gqlType: 'IssueCommentEdge',
          node: { __gqlType: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body },
        },
      };
    },
  },
};

function executeSelection(
  typeName: string,
  source: GqlObject,
  selection: readonly SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = SCHEMA[typeName];
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition !== null && node.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(typeName, source, node.selection, ctx));
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (allowed === undefined || !allowed.includes(node.name)) {
      throw new GraphQLError(`Cannot query field "${node.name}" on type "${typeName}".`);
    }
    const resolver = RESOLVERS[typeName]?.[node.name];
    const args = argsFromNodes(node.args, ctx);
    const value = resolver !== undefined ? resolver(source, args, ctx) : source[node.name];
    out[key] = completeValue(value, node.selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: SelectionNode[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (selection === null) throw new GraphQLError('list field requires a selection set');
    return value.map((item) => completeValue(item, selection, ctx));
  }
  if (typeof value === 'object') {
    const object = value as GqlObject;
    if (selection === null) throw new GraphQLError(`field of type ${object.__gqlType} requires a selection set`);
    return executeSelection(object.__gqlType, object, selection, ctx);
  }
  if (selection !== null) throw new GraphQLError('scalar field must not have a selection set');
  return value;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables: { ...variables } };
  for (const definition of operation.variables) {
    if (!(definition.name in ctx.variables) || ctx.variables[definition.name] === undefined) {
      if (definition.defaultValue !== null) {
        ctx.variables[definition.name] = valueFromNode(definition.defaultValue, ctx);
      }
    }
  }
  try {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const root: GqlObject = { __gqlType: rootType };
    const data = executeSelection(rootType, root, operation.selection, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

function executePayload(
  store: Store,
  payload: unknown,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  const body = payload as Record<string, unknown>;
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  const variables =
    body.variables !== undefined && typeof body.variables === 'object' && body.variables !== null
      ? (body.variables as Record<string, unknown>)
      : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
    }
  } else {
    if (operations.length > 1) {
      return { data: null, errors: [{ message: 'operationName is required when the document has multiple operations' }] };
    }
    operation = operations[0]!;
  }
  return executeOperation(store, operation, variables);
}

/** Handle one POST /api/graphql request, including batched array bodies. */
export function handleGraphql(store: Store, body: unknown, method: string): ApiResponse {
  if (method !== 'POST') return { status: 405, json: { errors: [{ message: 'method not allowed' }] } };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((payload) => executePayload(store, payload)) };
  }
  return { status: 200, json: executePayload(store, body) };
}
