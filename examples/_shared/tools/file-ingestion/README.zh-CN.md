# 文件采集工具

[English](README.md) · [应用工具](../README.zh-CN.md) · [文件路由](../../../control-flow/routing/file-type.ts)

这组工具接收原始文件路径，输出模型可读的解析内容。`index.ts` 使用公开的 `RegisteredTool` 契约，`parse.py` 接入第三方解析器。依赖、命令路径和模型配置属于示例应用，不进入 Core 的依赖或 YAML schema。

| 工具名 | 输入格式 | 实际处理 | 输出字段 |
| --- | --- | --- | --- |
| `decode_pdf` | PDF | 检查 PDF 签名，调用 Poppler `pdftotext -layout` | `text` |
| `read_spreadsheet` | CSV / XLSX | Python csv / openpyxl 读取原始文件 | `rows`，首行是表头 |
| `ocr_image` | PNG / JPEG | Pillow 解码校验图片类型，Tesseract `eng` OCR | `ocrText` |
| `transcribe_audio` | WAV / MP3 | 校验容器签名，faster-whisper 本地 CPU 转写 | `transcript` |

所有输出包含 `name`、`mediaType`、`sourceSha256` 和 `engine`，可核对实际处理的文件。工具不会读取测试 manifest 或接收预期答案。PDF 的文本提取不对扫描页自动 OCR；扫描内容通过图片 OCR 接入。示例默认英语 OCR/ASR，处理其他语言时由应用调整语言配置和模型。

## 安装与配置

要求 Python 3.12、Poppler、Tesseract 和 FFmpeg。FFmpeg 用于实验文件生成，faster-whisper 使用 PyAV 读取音频。以下从仓库根目录运行，Python 依赖独立安装在示例工具目录：

```bash
# macOS
brew install poppler tesseract ffmpeg uv
uv venv --python 3.12 examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/file-ingestion/requirements.lock

# 下载并缓存英语转写模型，后续转写可使用本地缓存
examples/_shared/tools/.venv/bin/python -c \
  'from faster_whisper import WhisperModel; WhisperModel("tiny.en", device="cpu", compute_type="int8")'
```

Linux 可安装 `poppler-utils tesseract-ocr ffmpeg espeak`，再执行同样的 uv 命令。端到端实验用 macOS `say` 或 Linux `espeak` 合成测试音频，再实际转写；不是把已知文本直接作为转写结果。

工具配置是 `createFileTools(config)` 的参数；CLI/实验通过以下应用环境变量传入：

| 变量 | 默认值 / 用途 |
| --- | --- |
| `DITTO_EXAMPLE_TOOLS_PYTHON` | `examples/_shared/tools/.venv/bin/python`，Python 可执行文件 |
| `DITTO_EXAMPLE_INPUT_ROOT` | CLI 输入文件的父目录，限制读取范围 |
| `DITTO_EXAMPLE_PDFTOTEXT` | `pdftotext` |
| `DITTO_EXAMPLE_TESSERACT` | `tesseract` |
| `DITTO_EXAMPLE_ASR_MODEL` | `tiny.en`；也可传本地 CTranslate2 模型目录 |

这些配置不使用 `DITTO_SHARED_*` 或 Core schema 注册第三方供应商。运行时调用的是应用明确提供的工具实例。注册方式：

```ts
import { createFileTools } from "./examples/_shared/tools/file-ingestion/index.ts";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";

const tools = createFileTools({ root: "/app/uploads", python: "/app/tools/.venv/bin/python" });
const interaction = createInteractionWorker({ tools, output: applicationOutputSink });
// createDitto({ config, sandbox: { ...config.sandbox, tools: tools.map(t => t.name) },
//   workers: [createInferWorker(), interaction] })
```

`applicationOutputSink` 是应用的输出适配器；完整可运行的注册与交付代码见[任务实验](../../../../scripts/check-examples-routing-tasks.ts)。`FileToolConfig` 还支持 `timeoutMs`，默认 180 秒。解析进程的环境仅包含 PATH、HOME 与 UTF-8 设置，不继承模型 Provider 凭据。

读取前检查 realpath 范围、普通文件类型和 50 MiB 上限，再由对应解码器验证内容。应用适配器使用本地子进程，工具权限由 Runtime 注册白名单控制；处理不可信文件时可将适配器部署到隔离的解析服务。

## 原始文件调用

```bash
npm run example:routing:file-type -- --file /absolute/path/pickup.pdf --media-type application/pdf
npm run example:routing:file-type -- --file /absolute/path/pickup.png --media-type image/png
npm run example:routing:file-type -- --file /absolute/path/pickup.wav --media-type audio/wav
```

`runFileTask(runtime, { id, model, file: { path, name, mediaType } })` 执行选图 → `INTERACTION.ACT.TOOL` 解析 → 模型提取 → `INTERACTION.OUTPUT`。返回 `{ content, samples, receipt, parsed }`，其中 `parsed` 保留解析器与文件摘要。只有已完成采集的应用才使用 `runFileType(runtime, { id, model, file: ParsedFile })` 直接处理解析结果。

## 完整任务实验

```bash
npm run check:examples:routing:tasks:package
```

命令在临时应用安装 npm tarball，用真实 PDF/CSV/XLSX/PNG/JPEG/WAV/MP3 验证从文件到最终交付产物的流程。原始文件、解析结果、独立预期、SQLite 业务记录、审批记录和交付文件保留在 `.examples-routing-tasks/run-*/`；汇总报告为 `.examples-routing-tasks-package-live-results.json`。实验不跳过缺失依赖，不将解析文本或工具结果替换成固定答案。Whisper 用法依据其[官方说明](https://github.com/SYSTRAN/faster-whisper)。

音频返回值同时包含 `transcript` 和 `segments: { start, end, text }[]`（秒）。`FileToolConfig.asrLanguage` 默认为 `en`，设为 `auto` 自动检测；其他语言需要对应的多语言 `asrModel`。
