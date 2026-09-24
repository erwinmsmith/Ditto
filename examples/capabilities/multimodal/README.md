# Document and multimodal understanding

[简体中文](README.zh-CN.md) · [Public API composition](../../../docs/worker-api/multimodal-workflows.md) · [Media tools](../../_shared/tools/multimodal/README.md)

Eight workflows compose public Runtime/Graph nodes: `INTERACTION`, `CONTEXT`, `MEMORY` and `INFER`. Application tools decode files; native image messages carry real pixels to a vision model. Context uses Redis and task checkpoints use file-backed SQLite Memory.

| Capability | Entry | Task output |
| --- | --- | --- |
| Document understanding | [document-parsing.ts](document-parsing.ts) | PDF/DOCX topics and facts with page/paragraph references |
| Document comparison | [document-comparison.ts](document-comparison.ts) | Common facts, changed fields and omissions across versions |
| Document review | [document-review.ts](document-review.ts) | Missing fields and violations against caller-supplied rules |
| Image understanding | [image-understanding.ts](image-understanding.ts) | Objects, colors and positions from actual pixels |
| Chart understanding | [chart-understanding.ts](chart-understanding.ts) | Bar labels, values, maximum and checked arithmetic |
| Audio transcription | [audio-transcription.ts](audio-transcription.ts) | WAV/MP3 transcript, timed segments and topic summary |
| Video understanding | [video-understanding.ts](video-understanding.ts) | Timestamped MP4 frames, events and motion direction |
| Meeting notes | [meeting-notes.ts](meeting-notes.ts) | Decisions, owners, actions and deadlines from a recording |

## Run

Use Node.js 24+, Redis, the [media dependencies](../../_shared/tools/multimodal/README.md), and a configured text model. Generated speech fixtures use macOS `say`; other platforms can supply their own WAV/MP3 and request file.

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
export DITTO_EXAMPLE_MEDIA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
export DITTO_EXAMPLE_VISION_PROVIDER=glm
export DITTO_EXAMPLE_VISION_MODEL=glm-4.6v-flashx
npm run example:multimodal:document-parsing
npm run example:multimodal:document-comparison
npm run example:multimodal:document-review
npm run example:multimodal:image-understanding
npm run example:multimodal:chart-understanding
npm run example:multimodal:audio-transcription
npm run example:multimodal:video-understanding
npm run example:multimodal:meeting-notes
```

The vision provider must exist in `ditto.yaml` and support native OpenAI-compatible `image_url` content. Selection is explicit; unavailable vision is an error. Each CLI creates `.examples-multimodal-tasks/cli-*` with inputs, `request.json`, immutable evidence snapshots, SQLite Memory and `output/report.json` / `output/report.md`. Audio tasks also retain a verbatim ASR transcript. Fixture expectations are read only by the test harness, never supplied to tools or models.

```sh
node --env-file=.env examples/capabilities/multimodal/document-parsing.ts --checkpoint
node --env-file=.env examples/capabilities/multimodal/document-parsing.ts --directory /absolute/task-directory
```

`--checkpoint` stops after durable parsing. `--directory` reads an existing `request.json` without regenerating inputs. To process your own files, provide paths relative to the task directory, MIME types, SHA-256 hashes and instructions. Requests are immutable per task ID. Run one controller per task.

## Evidence and recovery

The tool checks directory boundaries, size, bytes, MIME and hashes, then writes snapshots. Parsed evidence is saved through `MEMORY.WRITE` before Redis context is rebuilt. Inference loads Redis context; image bytes are loaded by a separate registered tool and are not stored in Redis/Memory. Validation checks schemas, evidence locations, exact text quotes and chart arithmetic. Publication rechecks snapshot hashes.

Expired/missing Redis context is restored from database Memory; connection failures propagate. Completed tasks reconcile existing files without another model call. Interrupted file delivery can fill missing files, but is not a multi-file transaction. External publishing should use a separate approval workflow.

## Scope

PDF requires a text layer; scanned PDFs need OCR first. DOCX supports body/table paragraphs, not legacy `.doc`, tracked changes, comments, headers/footers or embedded images. Paragraph references are not Word page numbers. PNG/JPEG inputs are orientation-corrected and resized. The chart example targets a single bar series.

Video is limited to 120 seconds and three frames at 10%, 50% and 90% of duration. Audio tracks and intervening events are not analyzed; sampling times and audio presence are recorded. Default ASR uses English `tiny.en`, without speaker diarization. Configure another model/language for multilingual input. Meeting owners come from spoken assignments, not inferred speaker identity. Unstated deadlines remain `unspecified`; relative dates remain relative.

Evidence and arithmetic checks do not certify every model interpretation. Reviews cover supplied rules only.

## Acceptance

```sh
npm run check:examples:multimodal:tasks
npm run check:examples:multimodal:tasks:package
```

The package gate installs the actual tarball outside the repository, checks strict public types without aliases, guards private imports and verifies silent imports. Task experiments use real models, Redis, SQLite and binary files through final artifact verification. Cases cover all eight capabilities, cache expiry, storage faults, invalid inputs, citation rejection, snapshot tampering, cancellation and three SIGKILL recovery points. Reports and artifacts are ignored by Git. SQLite acceptance does not imply PostgreSQL/MySQL/vector database acceptance.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
