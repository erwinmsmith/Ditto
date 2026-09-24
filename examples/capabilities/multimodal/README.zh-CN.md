# 文档与多模态理解

[English](README.md) · [公开 API 调用](../../../docs/worker-api/multimodal-workflows.zh-CN.md) · [媒体工具配置](../../_shared/tools/multimodal/README.zh-CN.md)

八个示例通过 `@codesoul-co/ditto/runtime` 的 Graph 组装 `INTERACTION`、`CONTEXT`、`MEMORY` 与 `INFER`。解析器和文件操作由应用注册为工具；图片和视频帧通过公开模型消息传入视觉模型。Context 使用真实 Redis，检查点存入文件 SQLite Memory。

| 能力 | 入口 | 输入与交付 |
| --- | --- | --- |
| 文档理解 | [document-parsing.ts](document-parsing.ts) | 阅读 PDF、DOCX，提取主题、关键事实与页码/段落引用 |
| 文档比较 | [document-comparison.ts](document-comparison.ts) | 比较两个版本的共同点、字段变化与遗漏 |
| 文档审查 | [document-review.ts](document-review.ts) | 按调用者规则区分缺失项与规则违反 |
| 图片理解 | [image-understanding.ts](image-understanding.ts) | 从真实图片像素识别对象、颜色与位置 |
| 图表理解 | [chart-understanding.ts](chart-understanding.ts) | 读取柱状图标签、数值、最大值与增量，校验算术 |
| 音频转写 | [audio-transcription.ts](audio-transcription.ts) | WAV/MP3 转写、片段时间戳和主题摘要 |
| 视频理解 | [video-understanding.ts](video-understanding.ts) | MP4 抽帧，输出带时间戳的事件与方向描述 |
| 会议记录整理 | [meeting-notes.ts](meeting-notes.ts) | 从真实录音转写中整理决定、负责人、行动与期限 |

## 运行

要求 Node.js 24+，Redis、Python 媒体依赖及配置好的文本模型。安装命令见[媒体工具](../../_shared/tools/multimodal/README.zh-CN.md)。演示语音生成使用 macOS `say`；其他平台可以直接提供自己的 WAV/MP3 和 `request.json`。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
export DITTO_EXAMPLE_MEDIA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
# provider 名须与 ditto.yaml 中的配置一致；模型必须支持原生 image_url 输入。
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

每个 CLI 创建独立的 `.examples-multimodal-tasks/cli-*` 目录，包含原始文件、`request.json`、`snapshots/`、`memory.sqlite` 与 `output/`。输出包括 `report.json`、`report.md`；音频任务另保留原始转写 `.txt`。演示样本的预期值只供测试使用，不传给工具或模型。

```sh
# 解析后停止，再从同一任务目录继续。
node --env-file=.env examples/capabilities/multimodal/document-parsing.ts --checkpoint
node --env-file=.env examples/capabilities/multimodal/document-parsing.ts --directory /absolute/task-directory
```

`--directory` 读取该目录的 `request.json`，不会重新生成输入。可复制示例请求，替换文件路径、MIME、SHA-256 和任务指令，处理自己的文件。每个任务 ID 对应固定请求；调整输入应创建新 ID。一个任务同时由一个控制器执行。

## 证据与恢复

输入先校验根目录边界、字节大小、签名和 SHA-256，再写入快照。解析结果先经 `MEMORY.WRITE` 保存，再用 `CONTEXT.LOAD` 重建 Redis 上下文。模型通过 `CONTEXT.LOAD` 获取资料；图像二进制由单独工具读取，不存入 Redis 或 Memory。分析结果通过结构、引用位置、原文片段和图表算术校验后保存；交付时重新核对快照校验值。

Redis 未命中/过期会从数据库 Memory 恢复；Redis/数据库连接故障会报错。重跑已完成任务核对现有产物，不重复调用模型。模型、转写、解析失败不会生成完成报告；已有解析检查点可以保留。文件交付可重复核对，部分文件写入后中断可继续补齐；这不是跨文件事务。外部发布仍应接入单独的审核/发布流程。

## 支持范围

- PDF 使用文本层；扫描 PDF 应先接入 OCR。DOCX 提取正文与表格单元格中的段落，不解析旧式 `.doc`、批注、修订、页眉页脚或嵌入图片。DOCX 引用是段落序号，不是分页位置。
- 图片支持 PNG/JPEG，经 EXIF 方向校正后缩放。图表示例针对单系列柱状图；模糊/无法读取的数据不能当作已确认事实。
- 视频上限 120 秒，在时长的 10%、50%、90% 抽取三帧。该示例不分析音轨，也不保证捕捉帧间短暂事件；原始时长、采样点和音轨存在性均写入证据。
- 默认 `tiny.en`、英语转写，无说话人分离；会议负责人来自口述内容，不能等同于说话人身份。多语言模型及语言选择见工具配置。未说明的期限保持 `unspecified`，相对日期不会自行转换为日历日期。
- 引用与算术校验验证结构和可追溯性，不能证明模型所有语义判断正确。审查仅覆盖输入规则，不能替代领域审核。

## 端到端验收

```sh
npm run check:examples:multimodal:tasks
npm run check:examples:multimodal:tasks:package
```

包验收在仓库外安装实际 npm tarball，执行无路径别名的严格类型检查、私有路径拦截与八个入口的无副作用导入。任务实验使用真实模型、Redis、SQLite、PDF/DOCX/PNG/WAV/MP4 文件，从解析到产物核对完整执行；覆盖八项能力、缓存过期、存储故障、错误输入、引用拒绝、快照篡改、取消与三个 SIGKILL 恢复点。报告和产物受 `.gitignore` 管理。此套存储验收使用 SQLite，不代表 PostgreSQL、MySQL 或向量库验收。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
