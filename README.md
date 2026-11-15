# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ulwan66/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ulwan66/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node.js process, written from scratch with no dependencies and no git binary. It serves four surfaces from a single in-memory store: git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under `/api/v3` for repositories, issues, pull requests and contents; the GraphQL v4 API at `/api/graphql`; and a Model Context Protocol endpoint at `/mcp` speaking revision 2026-07-28. Object storage is real git: SHA-1 ids, zlib packfiles with delta resolution, fast-forward enforcement, shallow and deepen fetches, and squash merges with three-way conflict detection.

## Run it

```sh
node main.ts
```

The trial harness sets `MAKEFUN_ENV_URL` (the suite to register with) and `MAKEFUN_SHOP_TOKEN` (the bearer token every API call presents). For a local run without the harness:

```sh
MAKEFUN_SHOP_TOKEN=dev-token node dev.ts 8081
```

Then drive it with any git/REST/GraphQL/MCP client against `http://127.0.0.1:8081`, presenting `Authorization: Bearer dev-token`.

## Layout

- `main.ts` — the trial lifecycle: bind an ephemeral port, register with the env, poll until done.
- `dev.ts` — standalone runner for local development.
- `src/server.ts` — HTTP routing, authentication, request ids.
- `src/store.ts` — the in-memory store: repositories, refs, issues, pull requests, labels, comments.
- `src/git-objects.ts` — git object model, packfile read/write, reachability, merge-base.
- `src/git-http.ts` — smart HTTP: protocol v2 advertisement, ls-refs, fetch, v0 upload-pack, receive-pack.
- `src/pktline.ts` — pkt-line framing and sideband encoding.
- `src/rest.ts` — the REST v3 surface.
- `src/graphql.ts` — a small GraphQL parser and executor for the v4 surface.
- `src/mcp.ts` — the MCP JSON-RPC surface and its six tools.
- `src/scenario.ts` — derives the token owner's login from the contest's fixed scenario seed.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
