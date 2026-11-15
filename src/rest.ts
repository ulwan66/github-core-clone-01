// The REST v3 surface under /api/v3. Routing and HTTP mapping only; the rules
// live in domain.ts. Every reply is JSON with a string `message` on errors,
// and every repository lookup that misses answers 404, never 403.

import { flattenTree, parseCommit, peelToCommit } from './git-objects.ts';
import type { ObjectLookup } from './git-objects.ts';
import {
  commentJson,
  commitOnBranch,
  createIssueRecord,
  createPullRecord,
  diffTrees,
  historyList,
  issueJson,
  lookupPath,
  mergePullRequest,
  pullFiles,
  pullJson,
  repoJson,
  resolveRef,
  treeOfCommit,
} from './domain.ts';
import { isoTime, Store } from './store.ts';
import type { Repo } from './store.ts';

export interface ApiResponse {
  status: number;
  /** null produces an empty body (204). */
  json: unknown;
  headers?: Record<string, string>;
}

function ok(json: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, json, headers };
}

function failure(status: number, message: string): ApiResponse {
  return { status, json: { message } };
}

function notFound(what = 'Not Found'): ApiResponse {
  return failure(404, what);
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30;
  return { page, perPage };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const build = (targetPage: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(targetPage));
    next.set('per_page', String(perPage));
    return `${origin}${path}?${next.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${build(page + 1)}>; rel="next"`);
    links.push(`<${build(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${build(1)}>; rel="first"`);
    links.push(`<${build(page - 1)}>; rel="prev"`);
  }
  return links.length > 0 ? links.join(', ') : undefined;
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/** `Name <email> timestamp tz` -> its parts, for commit author/committer views. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoTime(0) };
  const timestamp = Number.parseInt(match[3]!, 10);
  return { name: match[1]!, email: match[2]!, date: new Date(timestamp * 1000).toISOString() };
}

export function handleRest(
  store: Store,
  segments: readonly string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
  path: string,
): ApiResponse {
  // GET /api/v3/ — the root. Answers an object and the scopes header.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok({}, 200, { 'X-OAuth-Scopes': 'repo, user' });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0' });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    const viewer = store.viewer;
    return ok({ login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, perPage } = parsePage(query);
      const repos = store.listRepos();
      const link = linkHeader(origin, path, query, page, perPage, repos.length);
      return ok(paginate(repos, page, perPage).map((repo) => repoJson(store, repo)), 200, link === undefined ? undefined : { Link: link });
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const name = asString(input.name);
      if (name === undefined || name.trim() === '') return failure(422, 'name is required');
      const repo = store.createRepo(store.viewer.login, name, {
        description: asString(input.description),
        isPrivate: typeof input.private === 'boolean' ? input.private : undefined,
        defaultBranch: asString(input.default_branch),
      });
      if (repo === null) return failure(422, `name already exists on this account`);
      return ok(repoJson(store, repo), 201);
    }
    return notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return notFound();
    return handleRepoRoute(store, repo, segments.slice(3), method, query, body, origin, path);
  }

  return notFound();
}

function handleRepoRoute(
  store: Store,
  repo: Repo,
  tail: readonly string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
  path: string,
): ApiResponse {
  // /repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const description = asString(input.description);
      if (description !== undefined) repo.description = description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, json: null };
    }
    return notFound();
  }

  const head = tail[0]!;

  if (head === 'branches') {
    if (method !== 'GET') return notFound();
    if (tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .map((name) => name.slice('refs/heads/'.length))
        .sort();
      return ok(
        branches.map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`)! },
          protected: false,
        })),
      );
    }
    const branch = tail.slice(1).join('/');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return notFound('Branch not found');
    return ok({ name: branch, commit: { sha: tip }, protected: false });
  }

  if (head === 'commits' && tail.length === 1) {
    if (method !== 'GET') return notFound();
    const shaParam = query.get('sha');
    let start: string | undefined;
    if (shaParam !== null) {
      start = resolveRef(repo, shaParam);
      if (start === undefined) return notFound('No commit found for SHA');
    } else {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return ok([]);
      const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
      start = peelToCommit(lookup, tip) ?? undefined;
      if (start === undefined) return ok([]);
    }
    const commits = historyList(repo, start).map(({ sha }) => {
      const object = repo.objects.get(sha)!;
      const commit = parseCommit(object.data);
      return {
        sha,
        commit: {
          message: commit.message,
          author: parseIdentity(commit.author),
          committer: parseIdentity(commit.committer),
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return ok(commits);
  }

  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const ref = asString(input.ref);
      const sha = asString(input.sha);
      if (ref === undefined || !ref.startsWith('refs/')) return failure(422, 'ref must start with refs/');
      if (sha === undefined) return failure(422, 'sha is required');
      const object = repo.objects.get(sha);
      if (object === undefined) return failure(422, 'sha does not exist in this repository');
      if (repo.refs.has(ref)) return failure(422, 'Reference already exists');
      if (ref.startsWith('refs/heads/')) {
        const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
        if (peelToCommit(lookup, sha) === null) return failure(422, 'branch target must be a commit');
      }
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: object.type } }, 201);
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha } }));
        return ok(refs);
      }
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound('Reference not found');
      return ok({ ref, object: { sha } });
    }
    return notFound();
  }

  if (head === 'contents') {
    return handleContents(store, repo, tail.slice(1).join('/'), method, query, body);
  }

  if (head === 'labels') {
    if (tail.length !== 1) return notFound();
    if (method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const name = asString(input.name);
      if (name === undefined || name === '') return failure(422, 'name is required');
      if (repo.labels.has(name)) return failure(422, 'Label already exists');
      const label = { name, color: asString(input.color) ?? 'ededed' };
      repo.labels.set(name, label);
      return ok({ name: label.name, color: label.color }, 201);
    }
    return notFound();
  }

  if (head === 'issues') {
    return handleIssues(store, repo, tail.slice(1), method, query, body, origin, path);
  }

  if (head === 'pulls') {
    return handlePulls(store, repo, tail.slice(1), method, query, body, origin, path);
  }

  return notFound();
}

function handleContents(
  store: Store,
  repo: Repo,
  filePath: string,
  method: string,
  query: URLSearchParams,
  body: unknown,
): ApiResponse {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);

  if (method === 'GET') {
    const refParam = query.get('ref');
    const commitOid =
      refParam === null
        ? (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? undefined)
        : resolveRef(repo, refParam);
    if (commitOid === undefined) return notFound('Not Found');
    const peeled = peelToCommit(lookup, commitOid);
    if (peeled === null) return notFound('Not Found');
    const treeOid = treeOfCommit(repo, peeled);
    if (treeOid === undefined) return notFound('Not Found');
    const found = lookupPath(repo, treeOid, filePath);
    if (found === null) return notFound('Not Found');
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.entry.oid)!;
      const name = filePath.split('/').pop()!;
      return ok({
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name,
        path: filePath,
        sha: found.entry.oid,
        content: blob.data.toString('base64'),
      });
    }
    const entries = found.entries.map((entry) => {
      const entryPath = filePath === '' ? entry.name : `${filePath}/${entry.name}`;
      if (entry.mode === '40000') {
        return { type: 'dir', name: entry.name, path: entryPath, sha: entry.oid };
      }
      const blob = repo.objects.get(entry.oid);
      return { type: 'file', name: entry.name, path: entryPath, sha: entry.oid, size: blob?.data.length ?? 0 };
    });
    return ok(entries);
  }

  if (method === 'PUT') {
    const input = bodyObject(body);
    if (input === null) return failure(400, 'Request body must be a JSON object');
    const message = asString(input.message);
    const content = asString(input.content);
    if (message === undefined) return failure(422, 'message is required');
    if (content === undefined) return failure(422, 'content is required');
    const branch = asString(input.branch) ?? repo.defaultBranch;
    const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const files = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const peeled = peelToCommit(lookup, tip);
      const treeOid = peeled === null ? undefined : treeOfCommit(repo, peeled);
      if (treeOid !== undefined) {
        for (const [path, entry] of flattenTree(lookup, treeOid)) {
          files.set(path, { oid: entry.oid, mode: entry.mode });
        }
      }
    }
    const existing = files.get(filePath);
    const givenSha = asString(input.sha);
    if (existing !== undefined) {
      if (givenSha === undefined) return failure(422, 'sha is required to update a file');
      if (givenSha !== existing.oid) return failure(409, 'sha does not match the current file');
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    files.set(filePath, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const commitOid = commitOnBranch(store, repo, branch, files, message);
    const name = filePath.split('/').pop()!;
    return ok(
      {
        content: { type: 'file', encoding: 'base64', size: bytes.length, name, path: filePath, sha: blobOid },
        commit: { sha: commitOid, message },
      },
      existing === undefined ? 201 : 200,
    );
  }

  if (method === 'DELETE') {
    const input = bodyObject(body);
    if (input === null) return failure(400, 'Request body must be a JSON object');
    const message = asString(input.message);
    const givenSha = asString(input.sha);
    if (message === undefined) return failure(422, 'message is required');
    const branch = asString(input.branch) ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return notFound('Not Found');
    const peeled = peelToCommit(lookup, tip);
    const treeOid = peeled === null ? undefined : treeOfCommit(repo, peeled);
    if (treeOid === undefined) return notFound('Not Found');
    const files = new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of flattenTree(lookup, treeOid)) {
      files.set(path, { oid: entry.oid, mode: entry.mode });
    }
    const existing = files.get(filePath);
    if (existing === undefined) return notFound('Not Found');
    if (givenSha === undefined) return failure(422, 'sha is required to delete a file');
    if (givenSha !== existing.oid) return failure(409, 'sha does not match the current file');
    files.delete(filePath);
    const commitOid = commitOnBranch(store, repo, branch, files, message);
    return ok({ commit: { sha: commitOid, message }, content: null }, 200);
  }

  return notFound();
}

function handleIssues(
  store: Store,
  repo: Repo,
  tail: readonly string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
  path: string,
): ApiResponse {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const { page, perPage } = parsePage(query);
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const link = linkHeader(origin, path, query, page, perPage, issues.length);
      return ok(
        paginate(issues, page, perPage).map((issue) => issueJson(store, repo, issue)),
        200,
        link === undefined ? undefined : { Link: link },
      );
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const title = asString(input.title);
      if (title === undefined || title === '') return failure(422, 'title is required');
      const rawLabels = Array.isArray(input.labels) ? input.labels : [];
      const labelNames: string[] = [];
      for (const raw of rawLabels) {
        if (typeof raw === 'string') labelNames.push(raw);
        else if (typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).name === 'string') {
          labelNames.push((raw as Record<string, unknown>).name as string);
        }
      }
      const created = createIssueRecord(store, repo, {
        title,
        body: asString(input.body),
        labelNames,
      });
      if ('error' in created) return failure(422, created.error);
      return ok(issueJson(store, repo, created), 201);
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (tail.length === 1) {
    if (issue === undefined) return notFound('Issue not found');
    if (method === 'GET') return ok(issueJson(store, repo, issue));
    if (method === 'PATCH') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const state = asString(input.state);
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') return failure(422, 'state must be open or closed');
        issue.state = state;
      }
      const title = asString(input.title);
      if (title !== undefined) issue.title = title;
      const bodyText = asString(input.body);
      if (bodyText !== undefined) issue.body = bodyText;
      issue.updatedSeq = store.tick();
      return ok(issueJson(store, repo, issue));
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined && pull === undefined) return notFound('Issue not found');
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return ok(comments.map((comment) => commentJson(store, comment)));
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const text = asString(input.body);
      if (text === undefined) return failure(422, 'body is required');
      const comment = { id: store.nextId(), body: text, createdSeq: store.tick() };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return ok(commentJson(store, comment), 201);
    }
    return notFound();
  }

  return notFound();
}

function handlePulls(
  store: Store,
  repo: Repo,
  tail: readonly string[],
  method: string,
  query: URLSearchParams,
  body: unknown,
  origin: string,
  path: string,
): ApiResponse {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const { page, perPage } = parsePage(query);
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const link = linkHeader(origin, path, query, page, perPage, pulls.length);
      return ok(
        paginate(pulls, page, perPage).map((pull) => pullJson(store, repo, pull)),
        200,
        link === undefined ? undefined : { Link: link },
      );
    }
    if (method === 'POST') {
      const input = bodyObject(body);
      if (input === null) return failure(400, 'Request body must be a JSON object');
      const title = asString(input.title);
      const head = asString(input.head);
      const base = asString(input.base);
      if (title === undefined || title === '') return failure(422, 'title is required');
      if (head === undefined || head === '') return failure(422, 'head is required');
      if (base === undefined || base === '') return failure(422, 'base is required');
      const created = createPullRecord(store, repo, { title, body: asString(input.body), head, base });
      if ('error' in created) return failure(422, created.error);
      return ok(pullJson(store, repo, created), 201);
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound('Pull request not found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(pullJson(store, repo, pull));
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return notFound();
    return ok(
      pullFiles(repo, pull).map((diff) => ({
        filename: diff.filename,
        status: diff.status,
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.changes,
      })),
    );
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return notFound();
    const outcome = mergePullRequest(store, repo, pull);
    if (outcome.ok) {
      return ok({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    if (outcome.reason === 'conflict') return failure(405, 'Merge conflict');
    if (outcome.reason === 'already-merged') return failure(405, 'Pull request has already been merged');
    return failure(422, 'Head or base branch is missing');
  }

  return notFound();
}

export { diffTrees };
