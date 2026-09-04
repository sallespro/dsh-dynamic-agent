#!/usr/bin/env node
/**
 * Chain multiple subagents so each one's output becomes the next one's input.
 *
 * This is the multi-agent counterpart to dsh-dynamic-agent.mjs. It reuses that
 * script's conventions (runtime-authored plugin, patch overlay, .env loading,
 * DSH_HARNESS defaults) and adds the orchestration layer.
 *
 * Orchestration is NOT hand-rolled here. dsh already ships a workflow engine
 * (`ctx.workflowEngine` + `dsh-workflow-worker-thread`) exposed to the model as
 * the `workflow` tool, and dsh-base mounts both. It owns the task management
 * this problem needs:
 *
 *   - `agent(prompt, opts)`      start one child, resolve with its output
 *   - `pipeline(items, ...stages)` per-item stage chain; stage N's return value
 *                                 is stage N+1's `previous` argument — this IS
 *                                 the async output-to-input handoff
 *   - `parallel(thunks)`         independent work, joined
 *   - `phase()` / `log()`        progress narration for observers
 *
 * The engine also supplies the run bookkeeping we would otherwise have to
 * build: a run id, concurrency slots (maxConcurrentAgents), a runaway-loop
 * backstop (maxTotalAgents), per-item failure isolation, bounded cancellation
 * and disposal, and parent attribution so every child is traceable to the
 * invoking agent.
 *
 * TYPED HANDOFF: `agent()` takes a `schema` option and resolves with a
 * validated object instead of free text. That is what makes chaining reliable
 * — stage 2 reads `previous.topic`, not a sentence it has to re-parse.
 *
 * Usage:  node dsh-chain-agents.mjs [url]
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const scriptDir = dirname(fileURLToPath(import.meta.url))

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

const TARGET_URLS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["https://example.com"]

if (!process.env.OPENAI_API_KEY) {
  console.error(`OPENAI_API_KEY is not set and was not found in ${join(scriptDir, '.env')}`)
  process.exit(1)
}

const PROVIDER = process.env.DSH_PROVIDER ?? 'openai'
const MODEL = process.env.DSH_MODEL ?? 'gpt-4o-mini'
const PROFILE = process.env.DSH_PROFILE ?? 'sdk'
const HARNESS = process.env.DSH_HARNESS ?? join(homedir(), 'dev', 'deepseek-harness')
const DSH_BIN = process.env.DSH_BIN ?? join(HARNESS, 'apps', 'cli', 'lib', 'bin.js')

process.env.DSH_HOME ??= join(HARNESS, '.dsh-home')
const DSH_HOME = process.env.DSH_HOME

if (!existsSync(DSH_BIN)) {
  console.error(`No dsh launcher at ${DSH_BIN}`)
  console.error('Set DSH_HARNESS to your deepseek-harness checkout, or DSH_BIN to its bin.js. See README.md.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. The tool plugin (same contract as dsh-dynamic-agent.mjs).
// ---------------------------------------------------------------------------

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
      let parsed
      try {
        parsed = new URL(args.url)
      } catch {
        throw new Error(\`Not a valid URL: \${args.url}\`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(\`Only http(s) URLs are supported, got \${parsed.protocol}\`)
      }

      const response = await fetch(parsed, {
        signal: exec.signal,
        redirect: 'follow',
        headers: { accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
      })

      const full = await response.text()
      const cap = args.maxChars ?? maxChars
      const body = full.length > cap ? full.slice(0, cap) : full

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
      const emptyShell = isHtml && textContent.length < 60

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
// 2. The patch: the tool, plus a researcher subagent for the workflow's children.
// ---------------------------------------------------------------------------
// dsh-base already mounts the workflow engine (on the `spawn` provider) and the
// `workflow` tool, so nothing extra is needed to orchestrate. We only add our
// own tool and a filtered researcher instance.

function buildPatch (pluginUrl) {
  return `
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

    - id: tool-subagent-researcher
      name: '@deepseek-ai/dsh-tool-subagent'
      inject: [tools, subagents, systemPrompt, sessionProjections]
      config:
        provider: spawn
        toolName: researcher
        persona: >-
          You are a focused web researcher. Use the fetch_url tool to retrieve
          the pages you need, then answer with the findings and the URLs you
          actually fetched. Do not speculate about content you did not fetch.
        toolFilter:
          allow: [fetch_url]
        maxDepth: 1
        enableRunInBackground: false
`
}

// ---------------------------------------------------------------------------
// 3. The orchestration script — the two-agent chain under test.
// ---------------------------------------------------------------------------
// `pipeline(items, stageA, stageB)` runs both stages per item. Stage B's first
// argument (`previous`) is exactly what stage A returned, so the extractor's
// structured output flows into the writer as its input. Both agents declare a
// `schema`, so the handoff is a validated object rather than prose.

const ORCHESTRATION_SCRIPT = `
phase('extract')

const results = await pipeline(
  args.urls,

  // Stage 1 — EXTRACT. Reads the page, returns structured facts.
  async (previous, item, index) => {
    log('extracting ' + item)
    return await agent(
      'Use fetch_url to retrieve ' + item + ' and extract what it is. '
      + 'If the page has no readable text, say so in "notes" and set '
      + 'readable to false. Do not invent content you did not fetch.',
      {
        label: 'extract-' + index,
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            topic: { type: 'string' },
            readable: { type: 'boolean' },
            notes: { type: 'string' },
          },
          required: ['url', 'title', 'topic', 'readable', 'notes'],
          additionalProperties: false,
        },
      },
    )
  },

  // Stage 2 — SUMMARIZE. Its input IS stage 1's output object.
  async (previous, item, index) => {
    phase('summarize')
    if (previous === null) {
      return { url: item, ok: false, reason: 'extractor produced no result' }
    }
    log('summarizing ' + previous.title)
    const written = await agent(
      'Write one plain sentence for a general audience about this page, '
      + 'using ONLY these extracted facts (do not fetch anything, do not add '
      + 'facts): ' + JSON.stringify(previous),
      {
        label: 'summarize-' + index,
        schema: {
          type: 'object',
          properties: {
            sentence: { type: 'string' },
            audience: { type: 'string' },
          },
          required: ['sentence', 'audience'],
          additionalProperties: false,
        },
      },
    )
    if (written === null) {
      return { url: item, ok: false, reason: 'summarizer produced no result' }
    }
    // Prove the chain: carry stage 1's fields alongside stage 2's.
    return {
      url: previous.url,
      ok: true,
      extracted: { title: previous.title, topic: previous.topic, readable: previous.readable },
      summary: written.sentence,
      audience: written.audience,
    }
  },
)

return { chained: results.length, results }
`

// ---------------------------------------------------------------------------
// 4. Boot and run.
// ---------------------------------------------------------------------------

const profileDir = join(DSH_HOME, 'profiles', PROFILE)

if (!existsSync(profileDir)) {
  console.error(`No "${PROFILE}" profile at ${profileDir}. Provision it first — see README.md.`)
  process.exit(1)
}

const workdir = await mkdtemp(join(profileDir, 'dsh-chain-'))

try {
  const pluginPath = join(workdir, 'dynamic-web-fetch.mjs')
  const patchPath = join(workdir, 'dynamic.cordis.yml')

  await writeFile(pluginPath, PLUGIN_SOURCE, 'utf8')
  await writeFile(patchPath, buildPatch(pathToFileURL(pluginPath).href), 'utf8')

  console.error(`[dsh] workdir ${workdir}`)
  console.error(`[dsh] booting profile "${PROFILE}" ...`)
  console.error(`[dsh] chaining 2 agents over ${TARGET_URLS.length} url(s)`)

  await using harness = new DeepSeekHarness({
    launch: {
      command: DSH_BIN,
      args: ['--profile', PROFILE, '--patch', patchPath],
      cwd: process.cwd(),
    },
    provider: PROVIDER,
    model: MODEL,
    maxTokens: 32_768,
  })

  // The `workflow` tool takes meta + script + args and blocks the parent turn
  // until the whole run settles, so one turn yields the whole chain.
  const prompt = [
    'Run this exact orchestration with the workflow tool. Pass the script',
    'verbatim — do not rewrite it, and do not do the work yourself.',
    '',
    'meta: { "name": "extract-then-summarize",',
    '        "description": "Extract page facts, then summarize them" }',
    `args: ${JSON.stringify({ urls: TARGET_URLS })}`,
    '',
    'script:',
    ORCHESTRATION_SCRIPT,
    '',
    'Report the workflow result as JSON.',
  ].join('\n')

  const started = []
  const result = await harness.run(prompt, {
    onNotification: (note) => {
      if (note.method?.startsWith('subagent.')) {
        started.push(note.method)
        console.error(`[dsh] ${note.method}`)
      }
    },
  })

  console.error(`[dsh] session ${result.sessionId}`)
  console.error(`[dsh] subagent notifications: ${started.length}`)
  console.log('\n' + result.finalResponse)
} finally {
  await rm(workdir, { recursive: true, force: true })
}
