# File ingestion tools

[简体中文](README.zh-CN.md) · [Application tools](../README.md) · [File routing](../../../control-flow/routing/file-type.ts)

These application-owned `RegisteredTool` adapters consume original files. `index.ts` registers tools; `parse.py` connects third-party decoders. Their dependencies and configuration stay outside Core.

| Tool | Formats | Actual processing | Output |
| --- | --- | --- | --- |
| `decode_pdf` | PDF | PDF signature check and Poppler `pdftotext -layout` | text |
| `read_spreadsheet` | CSV / XLSX | Python csv / openpyxl | rows with a header |
| `ocr_image` | PNG / JPEG | Pillow format validation and Tesseract eng OCR | ocrText |
| `transcribe_audio` | WAV / MP3 | Container signature validation and local CPU faster-whisper | transcript |

Outputs also include name, mediaType, sourceSha256 and engine. Parsers never receive expected answers or read the acceptance manifest. PDF extraction does not automatically OCR scanned pages. This example uses English OCR/ASR; other languages require application configuration and appropriate models.

## Setup

Requires Python 3.12, Poppler, Tesseract and FFmpeg. FFmpeg generates acceptance fixtures; faster-whisper reads audio through PyAV. From the repository root:

```bash
# macOS
brew install poppler tesseract ffmpeg uv
uv venv --python 3.12 examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/file-ingestion/requirements.lock
examples/_shared/tools/.venv/bin/python -c \
  'from faster_whisper import WhisperModel; WhisperModel("tiny.en", device="cpu", compute_type="int8")'
```

On Linux, install `poppler-utils tesseract-ocr ffmpeg espeak`, then use the same uv commands. Acceptance fixtures use macOS say or Linux espeak to create real audio, followed by actual transcription. They do not substitute known text for ASR output.

`createFileTools(config)` accepts root, python, optional pdftotext/tesseract paths, asrModel and timeoutMs (default 180 seconds). CLI/acceptance configuration uses application environment variables:

| Variable | Default / purpose |
| --- | --- |
| `DITTO_EXAMPLE_TOOLS_PYTHON` | `examples/_shared/tools/.venv/bin/python` |
| `DITTO_EXAMPLE_INPUT_ROOT` | CLI input file's parent directory |
| `DITTO_EXAMPLE_PDFTOTEXT` | pdftotext |
| `DITTO_EXAMPLE_TESSERACT` | tesseract |
| `DITTO_EXAMPLE_ASR_MODEL` | tiny.en, or a local CTranslate2 model directory |

Pass tools into `createInteractionWorker({ tools, output })` and register their names in `sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) }`. See the [runnable task experiment](../../../../scripts/check-examples-routing-tasks.ts) for complete configuration. Subprocesses receive PATH, HOME and UTF-8 settings rather than application Provider credentials.

Tools check realpath confinement, regular files and a 50 MiB size limit before decoding. These are local application subprocesses; untrusted-file deployments can host the adapters in an isolated parsing service.

## Original-file workflow

```bash
npm run example:routing:file-type -- --file /absolute/path/pickup.pdf --media-type application/pdf
npm run example:routing:file-type -- --file /absolute/path/pickup.png --media-type image/png
npm run example:routing:file-type -- --file /absolute/path/pickup.wav --media-type audio/wav
```

`runFileTask(runtime, { id, model, file: { path, name, mediaType } })` selects a parser, invokes INTERACTION.ACT.TOOL, runs inference, and delivers through INTERACTION.OUTPUT. It returns `{ content, samples, receipt, parsed }`. `runFileType` remains available for applications that already have a ParsedFile.

## Task acceptance

```bash
npm run check:examples:routing:tasks:package
```

The command installs an npm tarball in a temporary consumer and exercises actual PDF/CSV/XLSX/PNG/JPEG/WAV/MP3 files through final persisted delivery. Original inputs, parser outputs, independent expectations, SQLite business records, reviews and delivery artifacts remain in `.examples-routing-tasks/run-*/`. The report is `.examples-routing-tasks-package-live-results.json`. Missing dependencies fail the check; parser/tool outputs are never replaced with fixed answers. Whisper integration follows its [official usage documentation](https://github.com/SYSTRAN/faster-whisper).

Audio results include both `transcript` and `segments: { start, end, text }[]` in seconds. `FileToolConfig.asrLanguage` defaults to `en`; use `auto` for detection and a multilingual `asrModel` for other languages.
