# Media tools

[简体中文](README.zh-CN.md) · [Workflows](../../../capabilities/multimodal/README.md)

`mediaTools(directory, request, config)` registers application-owned `multimodal_read`, `multimodal_images` and `multimodal_publish` tools. They decode/snapshot files, verify and load image bytes, and reconcile JSON/Markdown/transcript artifacts. Inject them into `createInteractionWorker`; invoke through Runtime.

```sh
brew install poppler ffmpeg
uv venv examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/file-ingestion/requirements.lock
npm install --prefix examples/_shared/tools/storage/dependencies
```

Linux can install `poppler-utils` and FFmpeg from its distribution. PDF/ASR reuse `file-ingestion/parse.py`; DOCX uses standard-library ZIP/XML, images use Pillow and video uses FFmpeg/ffprobe. Parser subprocesses receive only PATH, HOME and encoding settings, not provider credentials. Model inference stays in the public INFER Provider.

```ts
const tools = mediaTools(taskDirectory, request, {
  python: "/absolute/venv/bin/python",
  ffmpeg: "/opt/homebrew/bin/ffmpeg",
  ffprobe: "/opt/homebrew/bin/ffprobe",
  asrModel: "tiny.en",
  asrLanguage: "en",
  timeoutMs: 240_000,
});
```

CLI settings are `DITTO_EXAMPLE_MEDIA_PYTHON`, `DITTO_EXAMPLE_ASR_MODEL` and `DITTO_EXAMPLE_ASR_LANGUAGE`. For multilingual audio, select a multilingual model such as `small` and a language such as `zh`, or `auto` for detection. Initial model downloads need network/disk space. Default acceptance uses real faster-whisper inference on English synthesized audio with `tiny.en`; language configurability is not a language-specific accuracy benchmark.

Limits: 50 MiB per file, 20 MB expanded DOCX, 20 million image pixels, longest image edge 1280, 32000 text characters per file, 48000 characters of combined material. Oversized inputs fail rather than silently truncate. A trusted controller owns the task/output directory; it is not a multi-tenant filesystem sandbox. Do not mutate it concurrently.

Select the vision provider/model explicitly, for example `glm` / `glm-4.6v-flashx`. It must be configured already and accept native `image_url` messages; see [provider documentation](https://docs.z.ai/guides/vlm/glm-4.6v). No implicit provider creation or fallback occurs. Other multimodal protocols require application adapters.

Generated inputs, snapshots, databases and reports belong under `.examples-multimodal-tasks/`. Python caches and dependencies are excluded from publication. macOS `say` is used only to generate demonstration recordings, not to process user recordings.

The CLI sets `ModelConfig.providerOptions.response_format = { type: "json_object" }` for vision. The selected vendor must support it. When supplying your own `visionModel`, select a structured output mode supported by that provider.
