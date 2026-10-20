# anycode-v2

Agentic coding CLI that works with any model — now with **MCP connectivity**
(GitHub, Google Drive, Roblox Studio, or any Model Context Protocol server) and
a **skills system** for reusable instruction packs.

Original `anycode` design (model-agnostic providers, agentic tool loop,
permissions) is unchanged. v2 adds:

- **MCP client** — speaks JSON-RPC 2.0 over a stdio subprocess to any MCP
  server; tools appear as `mcp__<server>__<tool>` and are permission-gated.
- **Skills** — markdown instruction packs in `skills/` (project) or
  `~/.anycode/skills/` (global); the agent loads them on demand via `use_skill`,
  you can pin one with `/skill NAME`, and `/skills` lists them.

Zero runtime dependencies. Node >= 20.

## Quick start

```bash
npm install
npm run build
node dist/cli.js --provider openai --base-url http://localhost:11434/v1 \
  --model qwen2.5-coder:7b
```

Providers, profiles, one-shot mode, and permission prompts work exactly as in
anycode v1 — see the original repo sections that apply (`--profile`,
`-p "prompt"`, `--yes`, `anycode.config.json`).

## MCP servers

Drop an `mcp.json` in your project (or `~/.anycode/mcp.json` for global).
See [`mcp.json`](mcp.json) in this repo for a full example with GitHub,
Google Drive, and Roblox Studio entries.

Notes per server (install each per its own project's current instructions —
package names below were current when this file was written):

| Server | Where | Notes |
| --- | --- | --- |
| GitHub | `ghcr.io/github/github-mcp-server` (Docker) or the `github-mcp-server` binary | create a fine-grained personal access token, pass via env |
| Google Drive | `@modelcontextprotocol/server-gdrive` (npx) | needs OAuth credentials (see the server project README) |
| Roblox Studio | community `Roblox Studio MCP` servers on GitHub | they pair a Studio plugin with a local bridge; run the bridge process via `command`/`args` |
| anything else | any MCP server speaking stdio JSON-RPC | same shape |

Flags and slash commands:

```bash
anycode --mcp github,gdrive        # subset of configured servers
```

- `/mcp` — list connected servers + their tools (both in the banner and anytime)
- `/tools` — includes `mcp__…` tools once connected
- `--yes` — auto-approve (still recommended only for trusted servers)

MCP tool results are treated as untrusted data: any "instructions" inside a
tool result are shown to you, not followed silently.

Slash commands: `/model NAME` · `/tools` · `/mcp` · `/skills` · `/skill NAME` · `/quit`

## Skills

Create `skills/repair-dependencies.md` (private/global: `~/.anycode/skills/…`):

```markdown
# Repair broken dependency install

1. Delete node_modules and the lockfile only after checking package manager.
2. Run `npm install` and read the FIRST error (ignore the rest).
3. Fix root cause, not symptoms; verify with the project's typecheck.
```

The agent can call `use_skill` with that name when a matching task appears, or
you can pre-load it: `/skill repair-dependencies`. Active skills are injected
into the system prompt until the session ends.

Skills are pure markdown — no code execution — and are listed by `/skills`.

## Development

```bash
npm run typecheck         # tsc --noEmit
npx tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
# end-to-end with mocks (no network):
#   MCP: scripts/mock-mcp-server.mjs drives registry tests
#   model: scripts/mock-server*.mjs drive full CLI runs
```

## What's tested

| Area | Test | Verified |
| --- | --- | --- |
| MCP handshake (`initialize`, `initialized`) | mcp.test.ts | yes |
| MCP `tools/list` → namespaced `mcp__server__tool` wrappers | mcp.test.ts | yes |
| MCP `tools/call` (echo/add roundtrip) | mcp.test.ts | yes |
| MCP tools permission-gated (never `safe`) | mcp.test.ts | yes |
| Unknown MCP tool → isError surfaced to the loop | mcp.test.ts | yes |
| mcp.json + disabledTools loading | mcp.test.ts | yes |
| Skills list/load/activate/prompt-injection | mcp.test.ts | yes |
| `use_skill` tool roundtrip | mcp.test.ts | yes |
| v1 provider/loop/bash/grep e2e suite | e2e.test.ts | yes (unchanged, still green) |
| Full CLI run: model → MCP tool → final answer | manual (`mock-server-mcp.mjs` + mock MCP) | yes |
| `/mcp`, `/tools`, `/skills` slash commands | manual against mock server | yes |

Not yet tested live: real GitHub/GDrive/Roblox MCP servers (require external
credentials/installs — drop in your own configs and the same protocol path is
exercised).

## Design notes

Protocol subset implemented in `src/mcp/client.ts`: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call` over line-delimited
JSON-RPC on a spawned stdin/stdout pipe, with pending-request map, timeouts,
and exit-rejection. Registry in `src/mcp/index.ts` owns clients, disabled-tool
filtering, lazy reconnect, and loop-`Tool` adaptation. Skills in
`src/skills.ts` are filesystem markdown with project-over-user precedence.
