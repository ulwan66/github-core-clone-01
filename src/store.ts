// The forge's state: one in-memory store shared by the git, REST, GraphQL and
// MCP surfaces. Nothing here touches the wall clock or an unseeded random
// source: every timestamp is a fixed epoch plus a monotonic sequence number,
// so two runs fed the same requests leave identical state.

import { hashObject, packEntryBytes } from './git-objects.ts';
import type { GitObject, ObjType, ObjectLookup } from './git-objects.ts';
import type { ScenarioUser } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  headShaAtMerge: string | null;
  baseShaAtMerge: string | null;
  mergeCommitSha: string | null;
  mergedAtSeq: number | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  /** Cached full pack-entry bytes per object id; objects are immutable, so this never goes stale. */
  packEntries: Map<string, Buffer>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  commitCounter: number;
}

/** The epoch every logical timestamp is measured from; a fixed constant, never the wall clock. */
export const EPOCH_SECONDS = 1_700_000_000;

export function isoTime(seq: number): string {
  return new Date((EPOCH_SECONDS + seq) * 1000).toISOString();
}

export class Store {
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextRestId = 1;
  private sequence = 0;

  constructor(viewer: ScenarioUser) {
    this.viewer = viewer;
  }

  /** Advance the logical clock one tick and return the new sequence number. */
  tick(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** The next REST-facing object id (issues, pull requests, comments share one counter). */
  nextId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const seq = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdSeq: seq,
      objects: new Map(),
      packEntries: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      commitCounter: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** All repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /** Store an object (idempotent) and cache its pack entry; returns its id. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.packEntries.set(oid, packEntryBytes(type, data));
    }
    return oid;
  }

  /** An object lookup bound to one repository. */
  lookup(repo: Repo): ObjectLookup {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The tip of a branch, or undefined when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /**
   * Ensure a branch exists, creating it from the default branch's tip when it
   * does not. Returns the tip, or undefined when the repository has no
   * default-branch tip to fork from.
   */
  ensureBranch(repo: Repo, branch: string): string | undefined {
    const existing = this.branchTip(repo, branch);
    if (existing !== undefined) return existing;
    const tip = this.branchTip(repo, repo.defaultBranch);
    if (tip === undefined) return undefined;
    repo.refs.set(`refs/heads/${branch}`, tip);
    return tip;
  }

  /** The author/committer line for a commit this forge creates. */
  identityLine(repo: Repo): string {
    const stamp = EPOCH_SECONDS + repo.commitCounter;
    repo.commitCounter += 1;
    return `${this.viewer.name} <${this.viewer.email}> ${stamp} +0000`;
  }

  /** The head branch's tip as a pull request currently shows it: live while open, frozen at merge. */
  pullHeadSha(repo: Repo, pull: Pull): string {
    if (pull.headShaAtMerge !== null) return pull.headShaAtMerge;
    return this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  }

  /** The base branch's tip as a pull request currently shows it: live while open, frozen at merge. */
  pullBaseSha(repo: Repo, pull: Pull): string {
    if (pull.baseShaAtMerge !== null) return pull.baseShaAtMerge;
    return this.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  }
}
