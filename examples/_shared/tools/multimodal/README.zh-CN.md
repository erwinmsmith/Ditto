# 媒体工具配置

[English](README.md) · [示例入口](../../../capabilities/multimodal/README.zh-CN.md)

`mediaTools(directory, request, config)` 返回三个 `RegisteredTool`，由应用注入 `createInteractionWorker`：

| 工具 | 作用 |
| --- | --- |
| `multimodal_read` | 核对源文件并保存快照，解析文本、转写录音或抽取图片/视频帧 |
| `multimodal_images` | 验证图片快照哈希，按来源/时间戳加载原生图片消息 |
| `multimodal_publish` | 核对分析证据与快照，写入和核对 JSON、Markdown、转写文本 |

```sh
# macOS；Linux 可使用发行版的 poppler-utils、ffmpeg。
brew install poppler ffmpeg
uv venv examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/file-ingestion/requirements.lock
npm install --prefix examples/_shared/tools/storage/dependencies
```

PDF 和 ASR 复用 `file-ingestion/parse.py`；DOCX 使用 Python 标准库 ZIP/XML，图片使用 Pillow，视频使用 FFmpeg/ffprobe。Python 模块不接收模型密钥，子进程只继承必要的 PATH、HOME 和编码配置。模型通过 Ditto 的 INFER Provider 调用；媒体工具没有直接模型 HTTP 调用。

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

CLI 读取 `DITTO_EXAMPLE_MEDIA_PYTHON`、`DITTO_EXAMPLE_ASR_MODEL`、`DITTO_EXAMPLE_ASR_LANGUAGE`。多语言输入可选 `small` 与 `zh`，或 `auto` 自动检测；首次运行会下载对应 Whisper 模型，需要网络和磁盘空间。默认验收使用英语合成录音、`tiny.en` 和实际 faster-whisper 推理。选择语言参数并不代表已经完成该语言的准确率评估。

文件上限 50 MiB，DOCX 解压总量 20 MB，图片 2000 万像素并缩放至最长边 1280；每份文本最多 32000 字符，组合资料最多 48000 字符。超限报错，不静默截断。任务目录由可信控制器管理，不能作为多租户文件权限沙箱；不要允许其他进程并发修改该目录。输出目录由应用控制。

视觉模型在应用层显式选择，例如 `glm` / `glm-4.6v-flashx`；配置项依赖已注册的 Provider，不会自动创建供应商实例或切换模型。原生 `image_url` 消息格式见[视觉模型文档](https://docs.z.ai/guides/vlm/glm-4.6v)。其他协议须由应用适配，Core 不执行跨供应商媒体转换。

生成的样本、解析快照、数据库、报告放在 `.examples-multimodal-tasks/`；Python 缓存和依赖目录不加入发布包。真实任务入口不依赖 macOS `say`；该命令仅用于生成演示录音。

CLI 为视觉模型设置 `ModelConfig.providerOptions.response_format = { type: "json_object" }`；供应商须支持该选项。应用自行传入 `visionModel` 时也应明确选择供应商支持的结构化输出模式。
