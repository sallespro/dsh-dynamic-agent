# Chaining subagents: orchestration design

How to run multiple subagents and chain them so one run's output becomes the
next run's input, using the primitives dsh already provides.

Reference implementation: [`dsh-chain-agents.mjs`](dsh-chain-agents.mjs).

## The decision: use the workflow engine, don't build a task manager

The obvious approach is to write a scheduler in the host script — a task table,
a dependency graph, a queue, a poll loop that feeds finished outputs into
pending inputs. **Don't.** dsh ships that machinery already, and `dsh-base`
mounts it by default:

| Package | Role |
|---|---|
| `dsh-workflow` | The `ctx.workflowEngine` seam and run contract |
| `dsh-workflow-worker-thread` | The execution engine (runs scripts in a worker thread, children on the `spawn` provider) |
| `dsh-tool-workflow` | The model-facing `workflow` tool |

A hand-rolled orchestrator would have to re-implement run identity, concurrency
limits, a runaway-loop backstop, per-item failure isolation, bounded
cancellation and disposal, and parent attribution for every child. The engine
has all of it, and it is the seam the harness expects orchestration to use.

## The orchestration primitives

An orchestration script is a plain-JavaScript body (not TypeScript) with
top-level `await`, ending in `return <json-value>`. Inside it:

| Hook | Meaning |
|---|---|
| `agent(prompt, opts)` | Start one subagent; resolves with its final text, or a validated object when `opts.schema` is given |
| `pipeline(items, ...stages)` | Per-item stage chain. **Stage N's return value is stage N+1's `previous` argument** — this is the output-to-input handoff |
| `parallel(thunks)` | Independent work, joined |
| `phase(title)` / `log(msg)` | Progress narration for observers |
| `args` | The caller's JSON input, verbatim |

`agent()` options: `label`, `phase`, `provider`, `model`, `schema`.

### Why `pipeline` is the right shape for chaining

```js
pipeline(items, stageA, stageB)
```

runs `stageA` then `stageB` **per item**, with no cross-stage barrier: item 2
may reach stage B while item 1 is still in stage A. Each stage is called as
`(previous, item, index)`, so the chain is literal — whatever stage A returned
arrives as stage B's `previous`.

That is what makes the outputs *async inputs*: each item's chain advances
independently and concurrently, bounded only by the engine's concurrency slots.
Use `parallel()` when stages do **not** depend on each other, and `pipeline()`
when they do.

## Task management the engine provides

These are the reasons not to hand-roll it:

- **Run identity** — every run has a `runId`; `agent()` children carry `seq`,
  `label`, `phase`, and a `childId` session id.
- **Concurrency** — `maxConcurrentAgents` slots; `agent()` awaits a slot before
  starting, so a wide fan-out cannot stampede.
- **Runaway backstop** — `maxTotalAgents` (default 1000, per-run override)
  kills a script that spawns without bound.
- **Item cap** — `maxItemsPerCall` (default 4096) bounds one `pipeline()`/
  `parallel()` call.
- **Failure isolation** — an ordinary child failure resolves `agent()` to
  `null`; a stage throw drops **that item** to `null` and skips its remaining
  stages. Other items continue. The script decides what a `null` means.
- **Fatal vs ordinary** — hook misuse (bad option, unknown key, tripped cap)
  raises a fatal `WorkflowError` that kills the script loudly instead of
  silently mapping to `null`. Fatal errors are re-thrown through `parallel()`
  and `pipeline()`.
- **Lifecycle** — the run's `result` **never rejects**; it resolves with
  `stopReason: 'completed' | 'cancelled' | 'error'`. `cancel()` and `dispose()`
  are bounded and idempotent.
- **Attribution** — `parent` makes every child traceable to the invoking agent.

## Typed handoff between stages

Free text is a poor interface between agents: stage 2 must re-parse prose and
may hallucinate fields. Pass `schema` to `agent()` and the child returns a
**validated object**:

```js
const facts = await agent('…extract…', {
  label: 'extract-0',
  schema: {
    type: 'object',
    properties: { url: {type:'string'}, title: {type:'string'}, readable: {type:'boolean'} },
    required: ['url', 'title', 'readable'],
    additionalProperties: false,
  },
})
```

Stage 2 then reads `previous.title` and `previous.readable` directly. Note this
is **raw JSON Schema** (with a `required` array) — unlike a *tool's*
`output.schema`, which uses dsh's `ValueSchemaSpec` DSL where each property
carries its own `required`. The two look similar and are not interchangeable.

Carry forward the fields you want to prove came from the upstream stage. The
test returns stage 1's `extracted` block next to stage 2's `summary`, so a
reader can see the handoff happened rather than taking it on trust.

## Two ways to start a run

**Via the `workflow` tool (used by the test).** The model calls the tool with
`meta`, `script`, and `args`; it blocks the parent turn until the whole run
settles and returns `{ runId, agentsStarted, result }`. The parent sees one
final outcome, never intermediate child messages. This needs no new plugin —
`dsh-base` already mounts the tool.

**Programmatically.** `ctx.workflowEngine.start({ script, meta, args?, parent,
signal? })` from inside a plugin. Note `parent` is an `Agent`, so this path
requires a live agent handle — it belongs in a plugin, not in an SDK-client
script like ours. `start()` validates meta and parses the script *before* a run
exists, so malformed requests fail immediately. The caller owns the run and must
`dispose()` on every path.

The test uses the tool path because the SDK client drives the runtime from
outside and has no `Agent` to pass as `parent`.

## The test

`dsh-chain-agents.mjs` chains two agents over one or more URLs:

```
   fetch_url (tool)
        │
   ┌────▼──────────────┐        ┌───────────────────┐
   │ stage 1: EXTRACT  │ ─────► │ stage 2: SUMMARIZE│
   │ reads the page,   │previous│ reads ONLY stage 1│
   │ returns {url,     │        │ output, returns   │
   │  title, topic,    │        │ {sentence,        │
   │  readable, notes} │        │  audience}        │
   └───────────────────┘        └───────────────────┘
```

Stage 2 is explicitly told not to fetch anything — it may use only the facts
stage 1 handed it. That makes the chain observable: if the handoff were broken,
stage 2 would have nothing to summarize.

```bash
node dsh-chain-agents.mjs                                        # default url
node dsh-chain-agents.mjs https://example.com https://api.github.com/zen
```

### Verified results

Single URL — the result carries stage 1's fields beside stage 2's, proving the
handoff:

```json
{"chained": 1, "results": [{
  "url": "https://example.com", "ok": true,
  "extracted": {"title": "Example Domain", "topic": "Website Overview", "readable": true},
  "summary": "Example Domain is a website designed for use in documentation examples…",
  "audience": "general"}]}
```

Two URLs — 2 items × 2 stages = 4 children, correctly paired per item
(`chained: 2`, four `subagent.started`/`finished` notifications).

Unreadable page (`https://ai.cloudpilot.com.br`, a JS shell) — `readable:
false` propagates through the chain and stage 2 reports the limitation instead
of inventing content:

```json
{"extracted": {"title": "cloudpilot", "readable": false},
 "summary": "The Cloudpilot page features AI-driven services but lacks readable text as its content is dynamically loaded by JavaScript."}
```

## Extending the chain

- **More stages** — add another function to `pipeline(items, s1, s2, s3)`.
- **Fan out inside a stage** — call `parallel()` within a stage for independent
  sub-work, then reduce before returning to the next stage.
- **Different model per stage** — pass `model`/`provider` in `agent()` opts; a
  cheap extractor can feed an expensive writer.
- **Scoped tools per stage** — register a second `dsh-tool-subagent` instance
  with its own `toolFilter`, and select it with `agent()`'s `provider`.

## Gotchas

1. **Script is plain JS, not TypeScript**, and must end with `return`. It runs
   in a worker thread — no host imports, no closure over host variables. `args`
   is the only channel in.
2. **`agent()` schema is raw JSON Schema**; a tool's `output.schema` is
   `ValueSchemaSpec`. Don't copy one into the other.
3. **A `null` from `agent()` is an ordinary failure**, not a crash — handle it
   in the stage or the item silently becomes `null`.
4. **Don't re-insert the `spawn` provider or the workflow packages** — `dsh-base`
   mounts all of them; a duplicate fails the whole plugin tree.
5. **The `workflow` tool blocks the parent turn.** That is what makes one
   `harness.run()` return the whole chain, but it also means no streaming
   progress from children — watch `subagent.*` notifications instead.
