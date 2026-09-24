# Content processing APIs

[简体中文](content-workflows.zh-CN.md) · [Worker API](README.md) · [Seven examples](../../examples/capabilities/content/README.md)

Generation, rewriting, summarization, expansion, translation, conversion and citations compose existing public APIs. `INTERACTION.ACT.TOOL` reads/writes files, OBSERVE normalizes results, `CONTEXT.LOAD/UPDATE` maintain Redis working context, `INFER.REASONING.SAMPLE` generates/reviews content, and `MEMORY.GET/WRITE` persist checkpoints. Domain policy and rendering remain application-owned rather than dedicated Core nodes.

## Complete invocation

Use Node.js 24+, a real model and Redis as described in [setup](../../examples/capabilities/content/README.md). Save this as `content-example.ts` at the repository root:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { contentTools } from "./examples/_shared/tools/content/tools.ts";
import { createFixture } from "./examples/_shared/tools/content/fixtures.ts";
import { sandbox } from "./examples/capabilities/content/cli.ts";
import { run } from "./examples/capabilities/content/generate.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-content-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-content-tasks/example-"));
const request = await createFixture(directory, "generate");
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({ tools: contentTools(directory, request) }),
    ],
  });
  try {
    const result = await run(runtime, { request, model: { provider, model } });
    console.log(JSON.stringify({ directory, result }, null, 2));
  } finally { await runtime.close(); }
} finally { await storage.close(); }
```

```sh
npm run build
node --env-file=.env content-example.ts
```

This creates demonstration source files, reads them, generates/reviews content with a real model and publishes Markdown, JSON, HTML and source snapshots. Change both the entry and fixture mode to `rewrite`, `summarize`, `expand`, `translate`, `convert` or `cite` for other tasks.

`run(runtime, { request, model }, options?)` requires only Runtime's public `run` method. `signal` propagates cancellation; `stopAfter` accepts `material`, `draft` or `review` and returns `{ status: "checkpoint" }`. Completion returns `{ taskId, mode, draft, review, delivery }`; `delivery.files` lists actual filenames, SHA-256 hashes and byte counts.

## Input and evidence

`Request` contains task ID, tenant, mode, three protected `anchors`, and `sources: { id, file, sha256 }[]`. The example uses fixed brief/notes/draft text sources. Applications can replace source tools and domain validators without adding business formats or terminology to Core.

The source tool checks regular files, size and hash, retaining full text and `{ id, line, text }` blocks. For example, `brief:3` identifies the third source line. Memory retains snapshots and mappings so recovery, rendering and citations share one version. Changes before the snapshot commit fail; later recovery uses the committed snapshot. Updated sources require a new task.

## Generation and review

A Graph loads Redis context and calls `INFER.REASONING.SAMPLE` with model configuration, system policy, task requirements and materials. `generation: { temperature: 0, maxTokens: 8192 }` is call-level configuration; mode-specific character limits independently bound prose. Check successful `NodeResult`, `output` and `finishReason === "stop"` before parsing JSON. Truncated output is not published.

The application draft contract is:

```ts
interface Draft {
  title: string;
  language: "zh-CN" | "en";
  sections: {
    heading: string;
    text: string;
    citations: { blockId: string; quote: string }[];
  }[];
}
```

Titles, headings and prose must be nonempty. Quotes must exactly equal committed source blocks. Validators enforce language, length, protected facts, numbers and evidence coverage. Conversion also preserves the original title, exact paragraph text and order. Expansion preserves its lead and adds grounded material.

After validation, persist the draft in Memory and update Context before a separate real model review:

```ts
interface Review {
  approved: boolean;
  checks: {
    fidelity: boolean;
    coverage: boolean;
    transformation: boolean;
    citations: boolean;
  };
  issues: string[];
}
```

Publication requires every check and `approved` to be true, with no issues. Deterministic checks establish field/quote consistency; model review checks semantics. Automated review is not a proof of natural-language correctness or external source truth. Specialized/high-stakes content can connect to the existing human-review workflow.

## Citations and formats

The registered `content_publish` tool revalidates material, draft and review before rendering the same structured content into all formats. `content.json` includes resolved references with filename, line, exact quote and hash. HTML references jump to source explanations and link accompanying snapshots; Markdown retains source paths/lines. The model cannot choose arbitrary URLs or paths.

The application escapes HTML and Markdown. HTML executes no model code. `manifest.json` is written last and describes other files' hashes/sizes. Per-file immutable writes support identical replay and reject conflicts. Publication is not an atomic directory transaction: interruption may leave some completed files, which recovery verifies and fills in.

## Storage and recovery

Context scope is `content:<tenant>:<id>`. Public Memory nodes persist `input`, `material`, `draft`, `review` and `report`, each with a canonical request fingerprint. Missing Context can be rebuilt; connectivity failures abort. Unavailable Memory does not fall back to files or process memory.

Commit material before generation, draft before review, and approved review before publication. Recovery rebuilds Redis and reuses committed model results. A crash after publication but before the final report commit recovers through idempotent writes. The application closes Runtime, Memory and Redis clients.

## Installed-package acceptance

`npm run check:examples:content:tasks:package` installs a real npm tarball outside the repository, separately installs the application Redis SDK, checks strict types without paths aliases, blocks private Core/repository fallback imports, and silently imports seven entries. It then executes all 32 task scenarios and verifies model calls, real storage, files, citations and recovery.

Acceptance uses real model generation/review, Redis, file SQLite Memory and actual UTF-8/HTML/Markdown/JSON artifacts. A model text response alone is not task completion. This module's formats do not imply Word or PDF support.

For expansion, the application preserves the original lead verbatim from the committed snapshot. The model generates only additional sections; the assembled draft is validated and reviewed as a whole.
