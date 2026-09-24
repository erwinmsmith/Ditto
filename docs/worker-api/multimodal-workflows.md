# Public document and multimodal workflows

[简体中文](multimodal-workflows.zh-CN.md) · [Eight examples](../../examples/capabilities/multimodal/README.md)

Document reading, comparison, review, images, charts, transcription, video and meeting notes share existing public Worker APIs. Core handles scheduling, inference, Context and Memory. Applications own codecs, media tools, file access and domain validation.

| Stage | Public nodes | Application responsibility |
| --- | --- | --- |
| Restore | `MEMORY.GET` | Bind checkpoints to an immutable request fingerprint |
| Parse | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | Verify bytes, snapshot sources, decode documents, transcribe and sample video |
| Save | `MEMORY.WRITE` | Store evidence locations and media descriptors in a database |
| Context | `CONTEXT.LOAD` | Rebuild expired Redis context from Memory; propagate connection failures |
| Understand | `INFER.REASONING.SAMPLE` | Select text or explicit vision model; validate structured analysis |
| Deliver | `MEMORY.WRITE`, `INTERACTION.ACT.TOOL` | Verify quotes, locations, chart arithmetic and artifacts |

## Consumer usage

Install `@ditto/core` and copy the application examples/tools to your consumer project. Examples are not included in the Core tarball. Install the application Redis/media dependencies. Save this as `multimodal-app.ts` at the project root:

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { mediaTools } from "./examples/_shared/tools/multimodal/tools.ts";
import { resumeFixture } from "./examples/_shared/tools/multimodal/fixtures.ts";
import { sandbox, mediaConfig, models } from "./examples/capabilities/multimodal/cli.ts";
import { runMultimodal } from "./examples/capabilities/multimodal/shared.ts";

const directory = resolve(process.argv[2]!);
const request = await resumeFixture(directory);
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({ tools: mediaTools(directory, request, mediaConfig()) }),
    ],
  });
  try {
    const result = await runMultimodal(runtime, { request, ...models(config) });
    console.log(JSON.stringify(result));
  } finally {
    await runtime.close();
  }
} finally {
  await storage.close();
}
```

```sh
node --env-file=.env multimodal-app.ts /absolute/task-directory
```

`runMultimodal(runtime, input, options)` and entry-point `run` functions belong to the application, not new Core exports. Input contains `request`, text `model: ModelConfig`, and optional `visionModel: ModelConfig`. Tasks with images require a vision model; no text-only fallback occurs. Options accept `signal` and `stopAfter: "material" | "analysis"`.

A request contains `id`, `tenant`, `mode`, `instruction`, and `sources: {id,path,mediaType,sha256}[]`. A trusted controller owns the task directory. Use a new task ID for changed input or intentional reanalysis with a different model; completed checkpoints are not invalidated by model configuration changes. Another public `MemoryStore` adapter may replace the default SQLite storage.

## Native image messages

Public INFER messages accept vendor-native content arrays. An OpenAI-compatible vision model receives a text part followed by `{type:"image_url",image_url:{url:"data:image/jpeg;base64,..."}}`. Replace the placeholder with verified image bytes. The full workflow loads bytes through `multimodal_images` and places source IDs and image/frame locations beside each image. Select the configured provider/model explicitly with application environment variables.

Core does not open media paths, sample video or translate multimodal protocols between vendors. Audio goes through an application ASR tool, then a text model. Binary image data is not stored in Redis or Memory; durable descriptors refer to checked snapshots.

## Results and evidence

Analysis returns `summary`, `findings`, mode-specific `data`, and `limitations`. Findings contain `statement/sourceId/location/quote`. Text quotations must be exact substrings at the cited location. Visual quotations are empty: evidence is the actual pixels and their checksum. Reports retain PDF pages, DOCX paragraphs, ASR time spans, video timestamps and decoder identities. Chart validation additionally checks maximum and change arithmetic.

These checks establish traceability, not semantic correctness of every model conclusion. Video covers sampled frames only; default ASR acceptance uses English; DOCX covers body/table paragraphs. See the [full scope](../../examples/capabilities/multimodal/README.md). External publishing and approval remain separate workflows.

## Package acceptance

`npm run check:examples:multimodal:tasks:package` executes real media tasks and verifies cache expiry, database faults and SIGKILL recovery. The external consumer has no Core source tree or TypeScript paths aliases. A runtime hook blocks private entries. Python/media libraries are external dependencies; parser scripts are copied into the consumer rather than loaded from repository source.
