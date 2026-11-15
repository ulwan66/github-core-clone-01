// Git smart HTTP: the upload-pack and receive-pack services over HTTP, as the
// protocol documents them. upload-pack speaks both protocol v2 (advertisement,
// ls-refs, fetch) and the v0 fallback (advertisement, want/have fetch);
// receive-pack speaks v0 with report-status. All object transfer is through
// the packfile codec in git-objects.ts; this module only frames and selects.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  peelToObject,
  readPack,
  assemblePack,
  packEntryBytes,
  GitFormatError,
} from './git-objects.ts';
import type { ObjectLookup } from './git-objects.ts';
import {
  pktLine,
  pktFlush,
  parsePktLines,
  parsePktStream,
  packetTexts,
  sidebandData,
  PktLineError,
} from './pktline.ts';
import type { Repo, Store } from './store.ts';

export interface GitHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const AGENT = 'github-core-clone-01/1.0.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function badRequest(message: string): GitHttpResponse {
  return {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

/** Refs in byte-wise name order. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
  return refs;
}

/** The peeled id of a ref: the non-tag object its tag chain names, or null when it is not a tag. */
function peeledId(lookup: ObjectLookup, oid: string): string | null {
  const object = lookup(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToObject(lookup, oid);
}

/** The v0 advertisement: service preamble, then ref lines, the first carrying the capabilities. */
function v0Advertisement(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  capabilities: string,
): Buffer {
  const lookup = (oid: string) => repo.objects.get(oid);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const firstLine = (oid: string, name: string): Buffer => pktLine(`${oid} ${name}\0${capabilities}\n`);
  if (refs.length === 0) {
    parts.push(firstLine(ZERO_OID, 'capabilities^{}'));
  } else {
    parts.push(firstLine(headTip ?? ZERO_OID, 'HEAD'));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledId(lookup, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The protocol v2 advertisement: version line, capabilities, flush. No preamble. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

function handleInfoRefs(
  repo: Repo,
  service: string | null,
  gitProtocol: string | undefined,
): GitHttpResponse {
  if (service === 'git-upload-pack') {
    if (gitProtocol !== undefined && gitProtocol.includes('version=2')) {
      return { status: 200, headers: { 'Content-Type': UPLOAD_ADVERTISEMENT }, body: v2Advertisement() };
    }
    const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k shallow thin-pack ofs-delta agent=${AGENT}`;
    return {
      status: 200,
      headers: { 'Content-Type': UPLOAD_ADVERTISEMENT },
      body: v0Advertisement(repo, 'git-upload-pack', caps),
    };
  }
  if (service === 'git-receive-pack') {
    const caps = `report-status side-band-64k delete-refs agent=${AGENT}`;
    return {
      status: 200,
      headers: { 'Content-Type': RECEIVE_ADVERTISEMENT },
      body: v0Advertisement(repo, 'git-receive-pack', caps),
    };
  }
  return badRequest(`unknown service ${JSON.stringify(service)}`);
}

// ---------------------------------------------------------------------------
// ls-refs

function handleLsRefs(repo: Repo, lines: readonly string[]): GitHttpResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'command=ls-refs' || line.startsWith('agent=') || line.startsWith('object-format=')) {
      // Header lines; nothing to do.
    }
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lookup = (oid: string) => repo.objects.get(oid);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const out: Buffer[] = [];
  if (headTip !== undefined) {
    if (symrefs && matches('HEAD')) {
      out.push(pktLine(`${headTip} HEAD symref-target:${headRef}\n`));
    }
  } else if (unborn && matches('HEAD')) {
    const attr = symrefs ? ` symref-target:${headRef}` : '';
    out.push(pktLine(`unborn HEAD${attr}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledId(lookup, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return { status: 200, headers: { 'Content-Type': UPLOAD_RESULT }, body: Buffer.concat(out) };
}

// ---------------------------------------------------------------------------
// fetch selection

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

interface FetchSelection {
  packSet: Set<string>;
  shallowLines: string[];
  unshallowLines: string[];
}

/**
 * What the client already has: everything reachable from its haves, except
 * that a commit it names as shallow is a boundary — the commit itself and its
 * tree are had, but its parents are not. Without the boundary, a deepen fetch
 * would subtract the very ancestors it asks for.
 */
function collectHaveClosure(
  roots: readonly string[],
  lookup: ObjectLookup,
  shallow: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (isOid(root)) queue.push(root);
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Choose the objects a fetch sends. Commits are walked from the wants with a
 * distance limit (the deepen value, or unbounded); a commit's full tree and
 * blob closure rides along. Objects the client already has are subtracted.
 * Shallow lines mark pack commits whose parents fall outside the sent set and
 * the client's set; unshallow lines retire shallow marks the client sent once
 * the full ancestry is covered.
 */
function selectFetchObjects(repo: Repo, request: FetchRequest): FetchSelection {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const haveClosure = collectHaveClosure(request.haves, lookup, new Set(request.shallow));
  const limit = request.deepen ?? Number.POSITIVE_INFINITY;
  const packSet = new Set<string>();
  const commitDistance = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = [];

  const addTagChain = (oid: string): string | null => {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = lookup(current);
      if (object === undefined) return null;
      if (object.type !== 'tag') return current;
      packSet.add(current);
      current = parseTag(object.data).object;
    }
  };

  for (const want of request.wants) {
    if (!isOid(want)) continue;
    const target = addTagChain(want);
    if (target === null) continue;
    const object = lookup(target);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      queue.push({ oid: target, distance: 0 });
    } else {
      for (const oid of collectReachable([target], lookup, { allowMissing: true })) packSet.add(oid);
    }
  }

  while (queue.length > 0) {
    const { oid, distance } = queue.pop()!;
    const known = commitDistance.get(oid);
    if (known !== undefined && known <= distance) continue;
    commitDistance.set(oid, distance);
    if (distance >= limit) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    packSet.add(oid);
    const commit = parseCommit(object.data);
    for (const entry of collectReachable([commit.tree], lookup, { allowMissing: true })) packSet.add(entry);
    for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
  }

  for (const oid of haveClosure) packSet.delete(oid);

  const covered = new Set<string>([...packSet, ...haveClosure]);
  const shallowLines: string[] = [];
  for (const oid of packSet) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => !covered.has(parent))) shallowLines.push(`shallow ${oid}`);
  }
  shallowLines.sort();
  const unshallowLines: string[] = [];
  for (const oid of request.shallow) {
    if (!covered.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.every((parent) => covered.has(parent))) unshallowLines.push(`unshallow ${oid}`);
  }
  unshallowLines.sort();
  return { packSet, shallowLines, unshallowLines };
}

/** The packfile for a fetch selection, from cached per-object entries, ids sorted for stable bytes. */
function packForSelection(repo: Repo, selection: FetchSelection): Buffer {
  const ids = [...selection.packSet].sort();
  const entries: Buffer[] = [];
  for (const oid of ids) {
    const cached = repo.packEntries.get(oid);
    if (cached !== undefined) {
      entries.push(cached);
      continue;
    }
    const object = repo.objects.get(oid);
    if (object !== undefined) {
      entries.push(packEntryBytes(object.type, object.data));
    }
  }
  return assemblePack(entries);
}

function handleFetchV2(repo: Repo, lines: readonly string[]): GitHttpResponse {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) request.deepen = value;
    }
  }
  const selection = selectFetchObjects(repo, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush()];
  if (selection.shallowLines.length > 0 || selection.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of selection.shallowLines) parts.push(pktLine(`${line}\n`));
    for (const line of selection.unshallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandData(packForSelection(repo, selection)));
  parts.push(pktFlush());
  return { status: 200, headers: { 'Content-Type': UPLOAD_RESULT }, body: Buffer.concat(parts) };
}

function handleFetchV0(repo: Repo, firstBlock: readonly string[], secondBlock: readonly string[]): GitHttpResponse {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const raw of firstBlock) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      request.wants.push((space < 0 ? rest : rest.slice(0, space)).trim());
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) request.deepen = value;
    }
  }
  for (const raw of secondBlock) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
  }
  const selection = selectFetchObjects(repo, request);
  const parts: Buffer[] = [];
  for (const line of selection.shallowLines) parts.push(pktLine(`${line}\n`));
  for (const line of selection.unshallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandData(packForSelection(repo, selection)));
  parts.push(pktFlush());
  return { status: 200, headers: { 'Content-Type': UPLOAD_RESULT }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// upload-pack dispatch

function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string | undefined): GitHttpResponse {
  const isV2 = gitProtocol !== undefined && gitProtocol.includes('version=2');
  let stream;
  try {
    stream = parsePktStream(body);
  } catch (err) {
    if (err instanceof PktLineError) return badRequest(err.message);
    throw err;
  }
  const lines = packetTexts(stream.packets);
  if (isV2) {
    const first = lines[0]?.replace(/\n$/, '');
    if (first === 'command=ls-refs') return handleLsRefs(repo, lines);
    if (first === 'command=fetch') return handleFetchV2(repo, lines);
    return badRequest(`unknown upload-pack command ${JSON.stringify(first ?? '')}`);
  }
  // v0: first block is wants, the remainder after the flush is haves.
  let second: string[] = [];
  if (stream.rest.length > 0) {
    try {
      second = packetTexts(parsePktStream(stream.rest).packets);
    } catch (err) {
      if (err instanceof PktLineError) return badRequest(err.message);
      throw err;
    }
  }
  return handleFetchV0(repo, lines, second);
}

// ---------------------------------------------------------------------------
// receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseRefCommands(lines: readonly string[]): RefCommand[] | null {
  const commands: RefCommand[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || ref === '') return null;
    commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitHttpResponse {
  let parsed;
  try {
    parsed = parsePktLines(body);
  } catch (err) {
    if (err instanceof PktLineError) return badRequest(err.message);
    throw err;
  }
  const commands = parseRefCommands(packetTexts(parsed.packets));
  if (commands === null) return badRequest('receive-pack command lines are malformed');

  // Unpack first: objects from a refused push still enter the store.
  let unpackError: string | null = null;
  if (parsed.rest.length > 0) {
    try {
      const objects = readPack(parsed.rest, { resolveBase: store.lookup(repo) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          repo.packEntries.set(oid, packEntryBytes(object.type, object.data));
        }
      }
    } catch (err) {
      if (err instanceof GitFormatError) unpackError = err.message;
      else throw err;
    }
  }

  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const report: Buffer[] = [];
  if (unpackError !== null) {
    report.push(pktLine(`unpack error ${unpackError}\n`));
    for (const command of commands) report.push(pktLine(`ng ${command.ref} unpack failed\n`));
  } else {
    report.push(pktLine('unpack ok\n'));
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let failure: string | null = null;
      if (command.newOid === ZERO_OID) {
        if (current === undefined) failure = 'ref does not exist';
        else if (current !== command.oldOid) failure = 'old value mismatch';
        else repo.refs.delete(command.ref);
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) failure = 'ref already exists';
        else if (!repo.objects.has(command.newOid)) failure = 'object does not exist';
        else if (command.ref.startsWith('refs/heads/') && peelToCommit(lookup, command.newOid) === null) {
          failure = 'branch target is not a commit';
        } else repo.refs.set(command.ref, command.newOid);
      } else {
        if (current === undefined) failure = 'ref does not exist';
        else if (current !== command.oldOid) failure = 'old value mismatch';
        else if (!repo.objects.has(command.newOid)) failure = 'object does not exist';
        else if (command.ref.startsWith('refs/heads/') && peelToCommit(lookup, command.newOid) === null) {
          failure = 'branch target is not a commit';
        } else if (command.newOid !== current) {
          const oldCommit = peelToCommit(lookup, current);
          const newCommit = peelToCommit(lookup, command.newOid);
          if (oldCommit !== null && newCommit !== null && !isAncestor(lookup, oldCommit, newCommit)) {
            failure = 'non-fast-forward';
          } else repo.refs.set(command.ref, command.newOid);
        }
      }
      if (failure === null) report.push(pktLine(`ok ${command.ref}\n`));
      else report.push(pktLine(`ng ${command.ref} ${failure}\n`));
    }
  }
  report.push(pktFlush());
  const bodyOut = Buffer.concat([sidebandData(Buffer.concat(report)), pktFlush()]);
  return { status: 200, headers: { 'Content-Type': RECEIVE_RESULT }, body: bodyOut };
}

// ---------------------------------------------------------------------------
// entry point

/**
 * Handle one git request. `tail` is the path after `/{owner}/{repo}.git/`.
 * The caller has already authenticated and resolved the repository.
 */
export function handleGit(
  store: Store,
  repo: Repo,
  tail: readonly string[],
  method: string,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): GitHttpResponse {
  const gitProtocol = headers['git-protocol'];
  const protocolValue = Array.isArray(gitProtocol) ? gitProtocol[0] : gitProtocol;
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    return handleInfoRefs(repo, query.get('service'), protocolValue);
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    return handleUploadPack(repo, body, protocolValue);
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    return handleReceivePack(store, repo, body);
  }
  return {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
  };
}
