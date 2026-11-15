// The domain operations all four surfaces share: resolving refs, walking
// history, reading trees, diffing, creating issues and pull requests, and
// merging. The HTTP layers in rest.ts, graphql.ts and mcp.ts are thin mappings
// over these; the rules live here, once.

import {
  ZERO_OID,
  buildCommit,
  flattenTree,
  isOid,
  materializeTree,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
} from './git-objects.ts';
import type { GitObject, ObjectLookup, TreeEntry } from './git-objects.ts';
import { isoTime, Store } from './store.ts';
import type { Comment, Issue, Label, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// refs and history

/** Resolve a branch name, tag name, or raw id to the commit it names. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return peelToCommit(lookup, head) ?? undefined;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(lookup, tag) ?? undefined;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    if (object !== undefined && object.type === 'tag') return peelToCommit(lookup, ref) ?? undefined;
  }
  return undefined;
}

/** History from a tip: depth-first pre-order, each commit once, parents in order. */
export function historyList(repo: Repo, start: string): Array<{ sha: string; message: string }> {
  const seen = new Set<string>();
  const out: Array<{ sha: string; message: string }> = [];
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) visit(parent);
  };
  visit(start);
  return out;
}

/** The tree a commit names, or undefined when the commit is unknown. */
export function treeOfCommit(repo: Repo, commitOid: string): string | undefined {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------
// tree paths

export type PathLookup =
  | { kind: 'file'; entry: TreeEntry; size: number }
  | { kind: 'dir'; entries: TreeEntry[] }
  | null;

/** Walk a tree to a path: a file, a directory listing, or null when absent. */
export function lookupPath(repo: Repo, treeOid: string, path: string): PathLookup {
  if (path === '') {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(object.data) };
  }
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const dirObject = repo.objects.get(entry.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(dirObject.data) };
      }
      current = entry.oid;
    } else {
      if (!last) return null;
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return null;
      return { kind: 'file', entry, size: blob.data.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// diffs

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function textLines(content: Buffer): string[] {
  if (content.length === 0) return [];
  const text = content.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two file versions, by multiset difference. */
function countLineChanges(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const beforeLines = before === null ? [] : textLines(before);
  const afterLines = after === null ? [] : textLines(after);
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of afterLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

/**
 * The diff between two trees, as a list of per-file changes sorted by path.
 * A null tree is treated as empty.
 */
export function diffTrees(
  repo: Repo,
  baseTree: string | null,
  headTree: string | null,
): FileDiff[] {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const baseFiles = baseTree === null ? new Map() : flattenTree(lookup, baseTree);
  const headFiles = headTree === null ? new Map() : flattenTree(lookup, headTree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const baseEntry = baseFiles.get(path);
    const headEntry = headFiles.get(path);
    if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid === headEntry.oid) continue;
    const baseData = baseEntry === undefined ? null : (repo.objects.get(baseEntry.oid)?.data ?? null);
    const headData = headEntry === undefined ? null : (repo.objects.get(headEntry.oid)?.data ?? null);
    const { additions, deletions } = countLineChanges(baseData, headData);
    const status = baseEntry === undefined ? 'added' : headEntry === undefined ? 'removed' : 'modified';
    diffs.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// commits created by the forge itself

/**
 * Commit a file map onto a branch. The parent is the branch's tip, or the
 * default branch's tip when the branch is new, or nothing for a first commit.
 * Returns the new commit's id and moves the branch ref to it.
 */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const rawParent =
    repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parent = rawParent === undefined ? undefined : (peelToCommit(lookup, rawParent) ?? undefined);
  const treeOid = materializeTree(
    (type, data) => store.putObject(repo, type, data),
    files,
  );
  const identity = store.identityLine(repo);
  const parents = parent === undefined ? [] : [parent];
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents, authorLine: identity, committerLine: identity, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------------------
// issues and pull requests

export function createIssueRecord(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labelNames?: string[] },
): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of input.labelNames ?? []) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `Label "${name}" does not exist on this repository` };
    labels.push(label);
  }
  const seq = store.tick();
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    createdSeq: seq,
    updatedSeq: seq,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | { error: string } {
  const head = input.head.includes(':') ? input.head.slice(input.head.indexOf(':') + 1) : input.head;
  const base = input.base.includes(':') ? input.base.slice(input.base.indexOf(':') + 1) : input.base;
  const headTip = store.branchTip(repo, head);
  const baseTip = store.branchTip(repo, base);
  if (headTip === undefined) return { error: `Head branch "${head}" does not exist` };
  if (baseTip === undefined) return { error: `Base branch "${base}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { error: 'A pull request already exists for these branches' };
    }
  }
  const seq = store.tick();
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headShaAtCreate: headTip,
    baseShaAtCreate: baseTip,
    headShaAtMerge: null,
    baseShaAtMerge: null,
    mergeCommitSha: null,
    mergedAtSeq: null,
    createdSeq: seq,
    updatedSeq: seq,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The three-way conflict test: a path conflicts when both sides changed it differently from the base. */
export function pullHasConflict(repo: Repo, pull: Pull): boolean {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return false;
  const headCommit = peelToCommit(lookup, headTip);
  const baseCommit = peelToCommit(lookup, baseTip);
  if (headCommit === null || baseCommit === null) return false;
  const base = mergeBase(lookup, headCommit, baseCommit);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headCommit);
  const tipTree = treeOfCommit(repo, baseCommit);
  const baseFiles = baseTree === undefined || baseTree === null ? new Map() : flattenTree(lookup, baseTree);
  const headFiles = headTree === undefined ? new Map() : flattenTree(lookup, headTree);
  const tipFiles = tipTree === undefined ? new Map() : flattenTree(lookup, tipTree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const baseOid = baseFiles.get(path)?.oid;
    const headOid = headFiles.get(path)?.oid;
    const tipOid = tipFiles.get(path)?.oid;
    const headChanged = headOid !== baseOid;
    const tipChanged = tipOid !== baseOid;
    if (headChanged && tipChanged && headOid !== tipOid) return true;
  }
  return false;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already-merged' | 'missing-branch' };

/**
 * Squash-merge a pull request: one commit on the base branch, single parent,
 * carrying the head branch's changes over the base tip. On conflict nothing
 * changes and the pull request stays open.
 */
export function mergePullRequest(store: Store, repo: Repo, pull: Pull): MergeOutcome {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'already-merged' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing-branch' };
  if (pullHasConflict(repo, pull)) return { ok: false, reason: 'conflict' };

  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const headCommit = peelToCommit(lookup, headTip);
  const baseCommit = peelToCommit(lookup, baseTip);
  if (headCommit === null || baseCommit === null) return { ok: false, reason: 'missing-branch' };
  const base = mergeBase(lookup, headCommit, baseCommit);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headCommit);
  const tipTree = treeOfCommit(repo, baseCommit);
  const baseFiles = baseTree === undefined || baseTree === null ? new Map() : flattenTree(lookup, baseTree);
  const headFiles = headTree === undefined ? new Map() : flattenTree(lookup, headTree);
  const tipFiles = tipTree === undefined ? new Map() : flattenTree(lookup, tipTree);

  const merged = new Map<string, { oid: string; mode: string }>();
  for (const [path, entry] of tipFiles) merged.set(path, { oid: entry.oid, mode: entry.mode });
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const baseOid = baseFiles.get(path)?.oid;
    const headEntry = headFiles.get(path);
    if (headEntry === undefined) {
      if (baseOid !== undefined) merged.delete(path);
    } else if (headEntry.oid !== baseOid) {
      merged.set(path, { oid: headEntry.oid, mode: headEntry.mode });
    }
  }

  const treeOid = materializeTree((type, data) => store.putObject(repo, type, data), merged);
  const identity = store.identityLine(repo);
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: [baseCommit], authorLine: identity, committerLine: identity, message }),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  const seq = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedAtSeq = seq;
  pull.updatedSeq = seq;
  pull.headShaAtMerge = headTip;
  pull.baseShaAtMerge = commitOid;
  return { ok: true, sha: commitOid };
}

/** The file diff of a pull request: merge-base tree against the head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): FileDiff[] {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  const headCommit = peelToCommit(lookup, headTip);
  const baseCommit = peelToCommit(lookup, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(lookup, headCommit, baseCommit);
  const baseTree = base === null ? null : (treeOfCommit(repo, base) ?? null);
  const headTree = treeOfCommit(repo, headCommit) ?? null;
  return diffTrees(repo, baseTree, headTree);
}

// ---------------------------------------------------------------------------
// REST-shaped views

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: isoTime(repo.createdSeq),
    updated_at: isoTime(repo.createdSeq),
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: isoTime(issue.createdSeq),
    updated_at: isoTime(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? isoTime(issue.updatedSeq) : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAtSeq === null ? null : isoTime(pull.mergedAtSeq),
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: store.pullHeadSha(repo, pull),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: store.pullBaseSha(repo, pull),
      label: `${repo.owner}:${pull.baseRef}`,
    },
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: isoTime(pull.createdSeq),
    updated_at: isoTime(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? isoTime(pull.updatedSeq) : null,
  };
}

export function commentJson(store: Store, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: isoTime(comment.createdSeq),
    updated_at: isoTime(comment.createdSeq),
  };
}

export { ZERO_OID };
export type { GitObject };
