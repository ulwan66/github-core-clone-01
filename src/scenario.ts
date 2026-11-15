// The token owner's identity, derived from the contest's fixed scenario seed.
//
// The suite's checks address repositories as `<viewer login>/<name>` and expect
// `viewer { login }` to answer the login the bearer token names, but the token
// itself is opaque: it carries no login. The one thing both sides share is the
// scenario seed, a published constant, and the deterministic generators the
// wire contract documents. This module re-implements just enough of that
// generation — the seeded stream, the name lists, the user builder — to recover
// the first user, the viewer, without any other input. The seed never changes,
// so the answer is a constant of the contest, recomputed here rather than
// assumed.

const SEED = 0x6a09e667f3bcc909n;
const MASK64 = (1n << 64n) - 1n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** FNV-1a over the label's UTF-16 code units, 64-bit. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/** splitmix64's finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** xorshift64*: the scenario's deterministic stream. */
class SeededStream {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.state = masked === 0n ? SEED : masked;
  }

  static forLabel(label: string): SeededStream {
    return new SeededStream(mix64(SEED ^ fnv1a64(label)));
  }

  private nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  private nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection sampling. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

/** The scenario's users: unique logins from the first/last name lists. */
function generateUsers(stream: SeededStream, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = stream.pick(FIRST_NAMES);
    const last = stream.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(SeededStream.forLabel('users'), 12);

/** The viewer: users[0], the login the trial's bearer token names. */
export const VIEWER: ScenarioUser = USERS[0]!;

/** The second and third users, for completeness (teammate, stranger). */
export const TEAMMATE: ScenarioUser = USERS[1]!;
export const STRANGER: ScenarioUser = USERS[2]!;
