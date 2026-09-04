#!/usr/bin/env node
/**
 * Spawn a DeepSeek Harness (dsh) runtime with a plugin authored at runtime.
 *
 * The plugin is materialized at runtime, mounted through an invocation patch
 * layer, and contributes two things to the runtime:
 *   1. a `fetch_url` tool that retrieves data from the web
 *   2. a `researcher` subagent tool whose children may only use `fetch_url`
 *
 * The same patch points the harness at OpenAI through the pi-ai adapter. The
 * root agent is then prompted, delegates to the subagent, and we print the
 * final response. The generated directory is removed on exit.
 *
 * Requires DSH_HOME (a provisioned `sdk` profile) and DSH_BIN (the dsh
 * launcher). See README.md.
 *
 * Usage:  OPENAI_API_KEY=... node dsh-dynamic-agent.mjs "your prompt"
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const scriptDir = dirname(fileURLToPath(import.meta.url))

// Load this script's own .env so it runs with no shell setup. Values already
// in the environment win, so an explicit `FOO=... node script.mjs` still
// overrides the file. Deliberately minimal: KEY=VALUE, `export` prefix and
// surrounding quotes tolerated, `#` comments and blank lines skipped. A
// missing .env is not an error — the variable may come from the environment.
function loadDotEnv (path) {
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    if (key === '' || process.env[key] !== undefined) continue
    process.env[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/s, '$2')
  }
}

loadDotEnv(join(scriptDir, '.env'))

const PROMPT = process.argv.slice(2).join(' ')
  || 'Use the researcher subagent to fetch https://example.com and summarize what that page is for.'

// The route is served by the pi-ai adapter, which resolves `apiKeyEnv` per
// request through the credential seam — the key never enters a config file.
const PROVIDER = process.env.DSH_PROVIDER ?? 'openai'
const MODEL = process.env.DSH_MODEL ?? 'gpt-4o-mini'
const PROFILE = process.env.DSH_PROFILE ?? 'sdk'

if (!process.env.OPENAI_API_KEY) {
  console.error(`OPENAI_API_KEY is not set and was not found in ${join(scriptDir, '.env')}`)
  process.exit(1)
}

// The runtime is a built checkout rather than a global install, so there is no
// `dsh` on PATH to fall back to and both paths must be pointed somewhere real.
// These defaults match the setup in README.md; override either via the
// environment or .env when the checkout lives elsewhere.
const HARNESS = process.env.DSH_HARNESS ?? join(homedir(), 'dev', 'deepseek-harness')
const DSH_BIN = process.env.DSH_BIN ?? join(HARNESS, 'apps', 'cli', 'lib', 'bin.js')

// dsh reads DSH_HOME from the environment itself (the child inherits it), so
// set it rather than only passing it along.
process.env.DSH_HOME ??= join(HARNESS, '.dsh-home')
const DSH_HOME = process.env.DSH_HOME

if (!existsSync(DSH_BIN)) {
  console.error(`No dsh launcher at ${DSH_BIN}`)
  console.error('Set DSH_HARNESS to your deepseek-harness checkout, or DSH_BIN to its bin.js. See README.md.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. The plugin, authored here and written to disk at runtime.
// ---------------------------------------------------------------------------
// `defineTool` validates model-supplied args against `parameters` before
// `execute` runs, so the body can trust their types. `execute` returns only the
// canonical JSON value declared by `output.schema`; `output.render` owns the
// model-facing prose. Registration is effect-based: disposing this plugin's
// fiber unregisters the tool.

const PLUGIN_SOURCE = `
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dynamic-web-fetch'
export const inject = ['tools']

const DEFAULT_MAX_CHARS = 20_000

export function apply(ctx, config = {}) {
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS

  ctx.tools.register(defineTool({
    name: 'fetch_url',
    description:
      'Fetch a single HTTP(S) URL and return its response body as text. '
      + 'Use for retrieving pages, JSON APIs, or plain-text documents from the web.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to fetch.' },
      maxChars: { type: 'number', description: 'Truncate the body to this many characters.' },
    },
    output: {
      // output.schema is a ValueSchemaSpec, NOT raw JSON Schema: there is no
      // \`required\` array (each property carries \`required\` itself, as in
      // \`parameters\`) and an explicit object node must declare
      // \`additionalProperties\`.
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', required: true },
          status: { type: 'number', required: true },
          contentType: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          emptyShell: { type: 'boolean', required: true },
          textContent: { type: 'string', required: true },
          body: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: \`GET \${value.url} -> \${value.status} (\${value.contentType})\`
          + \`\${value.truncated ? ' [truncated]' : ''}\\n\\n\`
          + (value.emptyShell
            ? \`WARNING: this page returned no readable text — it is a \`
              + \`client-rendered shell whose content is loaded by JavaScript, \`
              + \`which this tool does not execute. You have NOT seen its \`
              + \`content. Report that the page could not be read; do NOT \`
              + \`describe or infer what it might contain.\\n\\n\`
              + \`Raw markup:\\n\${value.body}\`
            : value.body),
      }],
    },
    async execute(args, exec) {
      // Constraints the parameter DSL does not express are hand-checked here.
      let parsed
      try {
        parsed = new URL(args.url)
      } catch {
        throw new Error(\`Not a valid URL: \${args.url}\`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(\`Only http(s) URLs are supported, got \${parsed.protocol}\`)
      }

      // exec.signal is caller-owned and always present; honor it so an aborted
      // tool call does not leave a socket in flight.
      const response = await fetch(parsed, {
        signal: exec.signal,
        redirect: 'follow',
        headers: { accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      })

      const full = await response.text()
      const cap = args.maxChars ?? maxChars
      const body = full.length > cap ? full.slice(0, cap) : full

      // A client-rendered page (Vite/React/Vue shell) returns markup whose
      // body holds only a mount point: no prose reaches the model, which is
      // free to invent a plausible-sounding summary instead of reporting that
      // it found nothing. Detect the shape and say so in the canonical value.
      const contentType = response.headers.get('content-type') ?? 'unknown'
      const isHtml = contentType.includes('html') || full.trimStart().startsWith('<')
      const textContent = !isHtml
        ? full
        : full
          .replace(/<(script|style|noscript)\\b[^>]*>[\\s\\S]*?<\\/\\1>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;|&#\\d+;/gi, ' ')
          .replace(/\\s+/g, ' ')
          .trim()
      // Threshold tuned against real pages: a Vite/React shell strips to a
      // bare title (~10 chars), while example.com — a genuinely minimal but
      // readable page — strips to ~142. 60 separates them without flagging
      // small real pages.
      const emptyShell = isHtml && textContent.length < 60

      // A non-2xx response is a truthful domain outcome, not an infrastructure
      // failure, so it is represented in the canonical value rather than thrown.
      return {
        url: parsed.toString(),
        status: response.status,
        contentType,
        truncated: body.length < full.length,
        emptyShell,
        textContent,
        body,
      }
    },
  }))
}
`

// ---------------------------------------------------------------------------
// 2. The patch layer that mounts it.
// ---------------------------------------------------------------------------
// A patch is applied over the profile's own bundle layers. `insert` adds rows
// that the profile does not define; `name` is a module specifier the Loader
// resolves, so a file:// URL mounts our runtime-authored plugin without
// installing anything.
//
// tool-subagent exposes ONE configured provider to the model. Pointing it at
// the in-process `spawn` provider gives children that start fresh (they never
// see the parent conversation), and `toolFilter.allow` restricts each child to
// exactly the tool we just registered.

function buildPatch (pluginUrl) {
  return `
# dsh-base mounts the pi-ai multi-provider adapter dormant (zero routes) and
# defaults the agent to deepseek. These two id-targeted rows supply an OpenAI
# route and repoint the default model at it. A patch row REPLACES the whole
# config of the entry it names, so every field kept must be restated.
- id: llm-pi-ai
  config:
    providers:
      ${PROVIDER}:
        apiKeyEnv: OPENAI_API_KEY

- id: agent-default-model
  config:
    provider: ${PROVIDER}
    model: ${MODEL}

- insert:
    - id: dynamic-web-fetch
      name: '${pluginUrl}'
      config:
        maxChars: 20000

    # dsh-base already mounts the in-process 'spawn' provider (and a generic
    # 'subagent' tool over it). Re-inserting the provider fails the whole tree
    # with "a subagent provider named spawn is already registered", so we only
    # add a second tool instance with our own name, persona, and tool filter.
    - id: tool-subagent-researcher
      name: '@deepseek-ai/dsh-tool-subagent'
      inject: [tools, subagents, systemPrompt, sessionProjections]
      config:
        provider: spawn
        toolName: researcher
        # This script collects one turn and exits, so the delegation must
        # finish inside it. Left enabled, the model may pick run_in_background
        # and answer before the child returns ("I'll update you once the
        # subagent completes"), and the run ends with the work unfinished.
        enableRunInBackground: false
        persona: >-
          You are a focused web researcher. Use the fetch_url tool to retrieve
          the pages you need, then answer with the findings and the URLs you
          actually fetched. Do not speculate about content you did not fetch.
        toolFilter:
          allow: [fetch_url]
        maxDepth: 1
`
}

// ---------------------------------------------------------------------------
// 3. Boot the runtime with the patch and run one turn.
// ---------------------------------------------------------------------------

// A plugin mounted by file:// URL resolves its OWN imports from its OWN
// location, so a scratch dir under os.tmpdir() cannot see
// `@deepseek-ai/dsh-tools` and fails the entire plugin tree (which takes the
// LLM routes down with it). Author it inside the profile directory, where the
// harness packages resolve.
const profileDir = join(DSH_HOME, 'profiles', PROFILE)

if (!existsSync(profileDir)) {
  console.error(`No "${PROFILE}" profile at ${profileDir}. Provision it first — see README.md.`)
  process.exit(1)
}

const workdir = await mkdtemp(join(profileDir, 'dsh-dynamic-'))

try {
  const pluginPath = join(workdir, 'dynamic-web-fetch.mjs')
  const patchPath = join(workdir, 'dynamic.cordis.yml')

  await writeFile(pluginPath, PLUGIN_SOURCE, 'utf8')
  await writeFile(patchPath, buildPatch(pathToFileURL(pluginPath).href), 'utf8')

  console.error(`[dsh] plugin  ${pluginPath}`)
  console.error(`[dsh] patch   ${patchPath}`)
  console.error(`[dsh] booting profile "${PROFILE}" ...`)

  // The launch spec is explicit: this client does not know about profiles, so
  // we hand it the `dsh` bin and the launcher flags directly. `--profile sdk`
  // boots the JSON-RPC server this client speaks to, and `--patch` applies our
  // overlay after the profile's own bundle layers.
  //
  // The subprocess starts lazily and stays owned across run() calls; `await
  // using` guarantees the child is reaped even if the run throws.
  await using harness = new DeepSeekHarness({
    launch: {
      command: DSH_BIN,
      args: ['--profile', PROFILE, '--patch', patchPath],
      cwd: process.cwd(),
    },
    // The handshake route must name a provider the runtime actually serves —
    // here the pi-ai route the patch above registered.
    provider: PROVIDER,
    model: MODEL,
    maxTokens: 32_768,
  })

  const result = await harness.run(PROMPT, {
    onNotification: (note) => {
      // subagent.started / subagent.finished carry the lineage edges; surfacing
      // them makes the delegation visible from outside the runtime.
      if (note.method?.startsWith('subagent.')) {
        console.error(`[dsh] ${note.method}`)
      }
    },
  })

  console.error(`[dsh] session ${result.sessionId}`)
  console.log('\n' + result.finalResponse)
} finally {
  await rm(workdir, { recursive: true, force: true })
}
