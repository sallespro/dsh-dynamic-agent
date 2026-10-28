# dsh-dynamic-agent

A single script that spawns a DeepSeek Harness (dsh) runtime and adds a plugin
**authored at runtime** which registers a web-fetch tool and a subagent that
uses it. Routed to OpenAI via the pi-ai adapter.

**Status: working end to end** against a `master` checkout (dsh `0.2.2-alpha.2`,
re-verified 2026-10-28 after porting from `0.1.2-rc.1` — see
[Upgrading to dsh 0.2](#upgrading-to-dsh-02)). Verified runs
fetched `https://example.com` and `https://api.github.com/zen` through the
dynamically-registered tool, delegated via the subagent, and returned the real
content.

## Chaining multiple subagents

To run several subagents and feed one's output into the next, see
[ORCHESTRATION.md](ORCHESTRATION.md) and `dsh-chain-agents.mjs`. It uses dsh's
built-in workflow engine (`pipeline()` + `agent()` with structured schemas)
rather than a hand-rolled scheduler:

```bash
node dsh-chain-agents.mjs https://example.com https://api.github.com/zen
```

## What the script does

1. Writes a Cordis plugin (`fetch_url`, built with `defineTool`) into a fresh dir.
2. Writes a `cordis.patch.yml` overlay with two kinds of rows:
   - **id-targeted config overrides** — `llm-pi-ai` (adds the OpenAI route) and
     `agent-default-model` (repoints the default model at it)
   - **an `insert` block** — the runtime-authored plugin (by `file://` URL) and
     `dsh-tool-subagent` as a `researcher` tool, restricted via
     `toolFilter.allow: [fetch_url]`
3. Boots `dsh --profile sdk --patch <overlay>` as a subprocess and drives one
   turn over stdio JSON-RPC with `DeepSeekHarness`, printing `finalResponse`.
4. Deletes the generated dir in `finally`.

"In memory" is realized as **a generated file mounted through a patch layer**.
dsh resolves plugins as ES module specifiers through its Loader, so a `file://`
URL is the supported way to mount a plugin that was never installed. There is no
API to hand the Loader a JS object instead.

## Setup

The published npm packages **cannot run this** (see Known blockers). Build from
a `master` checkout, which is version-consistent:

On this machine that checkout is already built at `~/dev/deepseek-harness`,
with its profile home at `~/dev/deepseek-harness/.dsh-home` — the script's
defaults. (It is deliberately separate from `~/.dsh`, which holds a `web`
profile installed from the npm packages that hit the blockers below.) To
reproduce it elsewhere:

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git ~/dev/deepseek-harness
cd ~/dev/deepseek-harness && pnpm install --frozen-lockfile && pnpm run build
```

dsh requires the pnpm in its root `packageManager` field (**11.28.5** for `0.2.2-alpha.2`; `npx -y pnpm@11.28.5 …` works without a global install); a
plain `npm install` breaks its dependency closure. Then provision a profile and
link it at the built workspace packages:

```bash
export DSH_HOME=~/dev/deepseek-harness/.dsh-home
node ~/dev/deepseek-harness/apps/cli/lib/bin.js plugin --profile sdk add @deepseek-ai/dsh-sdk-app
```

The profile's `package.json` must list both bundles under `dsh.profile.bundles`
(`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]`), and its deps must
point at the checkout, e.g. from `$DSH_HOME/profiles/sdk`:

```bash
cd ~/dev/deepseek-harness/.dsh-home/profiles/sdk && pnpm add -w link:../../../packages/bundle/base link:../../../packages/bundle/sdk-app link:../../../packages/core/tools link:../../../packages/subagent/tool-subagent link:../../../packages/subagent/spawn-in-process link:../../../packages/preset/agent-preset link:../../../packages/preset/agent-preset-registry link:../../../packages/preset/persona
```

These are symlinks into the checkout, so **moving either directory breaks
them** — after a move, delete `profiles/sdk/node_modules` and re-run
`pnpm install` there.

The script itself only needs `@deepseek-ai/dsh-sdk-client` and
`@deepseek-ai/dsh-sdk-protocol` installed locally.

## Run

No environment setup needed — the script loads its own `.env` and defaults both
paths:

```bash
node dsh-dynamic-agent.mjs "fetch https://example.com and summarize it"
```

`OPENAI_API_KEY` comes from `dsh-dynamic-agent/.env` (a real shell variable wins
over the file, so `OPENAI_API_KEY=... node …` still overrides it).

| Variable | Default | Meaning |
|---|---|---|
| `DSH_HARNESS` | `~/dev/deepseek-harness` | The built checkout; the two paths below derive from it |
| `DSH_BIN` | `$DSH_HARNESS/apps/cli/lib/bin.js` | The dsh launcher to spawn |
| `DSH_HOME` | `$DSH_HARNESS/.dsh-home` | Harness home holding `profiles/<profile>` |
| `DSH_PROFILE` | `sdk` | Profile to boot |
| `DSH_PROVIDER` | `openai` | pi-ai route name |
| `DSH_MODEL` | `gpt-4o-mini` | Model on that route |

If the checkout lives elsewhere, set `DSH_HARNESS` (or `DSH_BIN`/`DSH_HOME`
individually) in the environment or in `.env`. A missing launcher or profile
fails at startup naming the exact path, rather than surfacing later as
`spawn dsh ENOENT` or `no adapter registered for provider "openai"`.

## Upgrading to dsh 0.2

Three breaking changes between `0.1.2-rc.1` and `0.2.2-alpha.2`, all handled here:

1. **`DeepSeekHarness` launch options are flat.** `launch: { command, args, cwd }`
   is *silently ignored*; the client then falls back to the dsh tree published
   to npm (which is missing `@deepseek-ai/cordis-plugin-group` and dies with
   `JSON-RPC input closed`). Use `profile`, `dshBin`, `dshHome`, `patches`,
   `processCwd` (and `cwd` for the session directory). Spawn from the harness
   checkout (`processCwd: HARNESS`) so no project-local dsh is picked up.
2. **Child persona/tools are agent presets.** `dsh-tool-subagent` rejects
   `persona` and `toolFilter` at load. The patch now mounts
   `agent-preset-registry` and a `researcher` preset (`dsh-persona` + the
   runtime-authored `fetch_url` plugin) and points the tool at it with
   `agentPreset: researcher`. Presets inherit the profile's global tools, so the
   built-in `tool-web` is disabled to keep `fetch_url` the only fetcher.
3. **Delegation is asynchronous.** A subagent call returns
   `started subagent <id>` and the answer arrives as a notice; `run()` keeps
   observing until the session is idle, so a one-shot script still gets the
   final answer. `enableRunInBackground` no longer exists.

The profile also needs `dsh-subagent-spawn-in-process`, `dsh-agent-preset`,
`dsh-agent-preset-registry` and `dsh-persona` linked (command above). Set
`DSH_DUMP_EVENTS=1` (or `2` for long payloads) to print every session event;
each `assistant/message` carries `data.usage.{inputTokens,outputTokens}`.

## Six things that bite

Each cost a debugging cycle; all are now handled in the script.

1. **The plugin must live where `@deepseek-ai/dsh-tools` resolves.** A `file://`
   plugin resolves its own imports from its own location, so `os.tmpdir()` fails
   with `Cannot find package '@deepseek-ai/dsh-tools'` — and that failure takes
   down the *entire* plugin tree, including the LLM routes, surfacing as the
   misleading `no adapter registered for provider "openai"`. The script writes
   into `$DSH_HOME/profiles/<profile>/` instead.
2. **`output.schema` is a `ValueSchemaSpec`, not raw JSON Schema.** No
   `required: [...]` array (each property carries `required: true` itself);
   explicit object nodes must declare `additionalProperties`. Otherwise:
   `schema.required is not supported by the value schema DSL`.
3. **Don't re-insert the `spawn` subagent provider.** `dsh-base` already mounts
   it (plus a generic `subagent` tool). Re-inserting fails the tree with
   `a subagent provider named "spawn" is already registered`. Add only a second
   `dsh-tool-subagent` instance with its own `toolName`.
4. **`llm-pi-ai` is mounted dormant with zero routes.** Supply routes via a
   patch row (plugin config is the settings `base` layer) or via
   `$DSH_HOME/settings.yaml` under the `llm-pi-ai` namespace. Both work;
   `apiKeyEnv` is resolved per request through the credential seam, so the key
   never enters a config file.
5. **(0.1 only) `run_in_background` broke one-shot runs.** Superseded in 0.2:
   delegation is always asynchronous and `run()` waits for the session to go
   idle (see [Upgrading](#upgrading-to-dsh-02)).
6. **A client-rendered page invites fabrication.** `fetch_url` does not execute
   JavaScript, so a Vite/React shell yields markup with no prose — and the
   model will happily invent a confident summary from nothing. Observed
   directly: an empty shell produced an invented page description with
   features, testimonials, and case studies. The tool now strips tags, and when
   the remaining text is under 60 characters it sets `emptyShell: true` and
   tells the model it has *not* seen the content and must not describe it.
   (Threshold tuned against real pages: a Vite shell strips to ~10 chars,
   example.com to ~142.)

## Known blockers in the published npm packages

Faults in the published developer-preview packages, which is why the build path
above is still required (the 0.1 faults below were observed on `rc.1`; with
`0.2.2-alpha.2` the npm `dsh` tree is still unusable — it lacks
`@deepseek-ai/cordis-plugin-group`):

- `@deepseek-ai/dsh-tools@0.0.1-rc.1` imports `CallId` from
  `@deepseek-ai/dsh-llm`, but `dsh-llm@0.1.2-rc.1` exports it as `ToolCallId`
  (`master` uses `ToolCallId` throughout). Any `defineTool` plugin fails to import.
- `@deepseek-ai/dsh-tool-subagent` and `@deepseek-ai/dsh-sdk-jsonrpc-server`
  depend on `@deepseek-ai/dsh-tasks`, which is **not published** (404).

The `dsh-sdk-client` constructor took `{ launch: { command, args, cwd } }` in
`0.0.1-rc.1`; from `0.2` it takes the flat `{ profile, dshBin, dshHome, patches,
processCwd }` shown in its README (this repo pins `0.2.2-alpha.2`).

## Security note

`.env` holds a live API key in plaintext; it is git-ignored. Rotate the key if
it has ever been shared.
