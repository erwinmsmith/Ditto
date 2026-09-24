# 工具和系统操作

[English](README.md) · [基础能力](../README.zh-CN.md) · [API 调用指南](../../../docs/worker-api/tool-workflows.zh-CN.md)

十个独立入口通过 Ditto 的公开 API 完成真实任务：加载上下文、由模型选择工具并补全参数、校验应用权限、执行工具、观察结果、保存检查点并交付产物。模型使用原生工具调用协议，业务工具通过 `createInteractionWorker({ tools })` 注入。

| 能力 | 入口 / npm 命令后缀 | 实际操作和核验 |
| --- | --- | --- |
| 工具选择 | [selection.ts](selection.ts) / `selection` | 在订单与库存工具中选择订单查询，读取订单金额和支付状态 |
| 参数补全 | [parameters.ts](parameters.ts) / `parameters` | 从 Redis 上下文补全国家、重量与服务，调用 HTTP 运费接口 |
| API 调用 | [api.ts](api.ts) / `api` | 请求独立 HTTP 服务，校验汇率响应 |
| 数据库查询 | [database.ts](database.ts) / `database` | 使用绑定参数与租户条件查询业务 SQLite |
| 文件读写 | [files.ts](files.ts) / `files` | 读取草稿、追加指定内容、保存并回读 `final.txt` |
| 代码执行 | [code.ts](code.ts) / `code` | 模型生成 JavaScript，交由 Docker 中的 Node.js 执行并验证计算结果 |
| 网页操作 | [browser.ts](browser.ts) / `browser` | Chromium 填写订单、点击查询与下载，验证 CSV 并保存截图 |
| 桌面操作 | [desktop.ts](desktop.ts) / `desktop` | 操作 Electron 原生可见窗口，输入标题与正文、点击保存、回读文件并截图 |
| 消息发送 | [message.ts](message.ts) / `message` | 通过 SMTP 投递邮件，核对测试邮箱实际收到的收件人、主题与正文 |
| 系统写入 | [system-write.ts](system-write.ts) / `system-write` | 通过 HTTP PATCH 更新 CRM 工单，回读版本和幂等操作记录 |

## 安装和运行

使用 Node.js 24+、已配置的真实模型和 Redis。按照 [第三方工具配置](../../_shared/tools/operations/README.zh-CN.md) 安装 Redis 客户端、浏览器、Electron、邮件 SDK 和 Docker 执行环境。模型连接使用根目录 `ditto.yaml` / `.env`，Redis 使用 `DITTO_WORKER_CONTEXT_REDIS_URL`。

```sh
npm run example:tools:selection
npm run example:tools:parameters
npm run example:tools:api
npm run example:tools:database
npm run example:tools:files
npm run example:tools:code
npm run example:tools:browser
npm run example:tools:desktop
npm run example:tools:message
npm run example:tools:system-write
```

每次调用生成独立的 `.examples-operations-tasks/cli-*` 任务目录。CLI 输出目录及结果。所有任务交付 `artifacts/operation.json`，其中包含 `operationId`、工具名、执行值、证据、已验证计划与 `verified: true`。文件、下载、桌面任务还保留各自的文件和截图。目录已忽略，不应提交到仓库。

在模型计划保存后退出，随后使用同一目录继续：

```sh
npm run example:tools:browser -- --checkpoint
# 用上一条命令输出的实际 directory 替换下面路径。
npm run example:tools:browser -- --directory .examples-operations-tasks/cli-XXXXXX
```

`--provider <name>` 选择配置中的模型提供方。恢复时 HTTP/SMTP 参考服务重新绑定原任务端口；端口占用会报错。任务 ID 对应固定输入，修改输入需要新建任务。

## 存储与恢复

- **Context**：真实 Redis，按租户与任务 ID 隔离。缓存过期时从数据库 Memory 中的任务输入、计划与回执重建；Redis 不可用时失败，不回退到进程内缓存。
- **Memory**：通过公开 `MEMORY.GET/WRITE` 保存四个阶段，使用独立 `memory.sqlite`。可通过公开 MemoryStore 接口替换适配器；本模块验收数据库为 SQLite。
- **业务系统**：独立 `business.sqlite` 保存订单、库存、工单、接收邮件与幂等记录，不替代 Memory Worker。

工具调用前保存计划，业务结果核验后保存回执。恢复已有结果不重新调用模型或重做业务操作；发布失败可重试。邮件和 CRM 在回执尚未落盘的恢复窗口先核对接收端记录。参考邮箱按 Message-ID 去重，CRM 在同一事务内记录幂等键和更新结果；普通 SMTP 服务不自动具备这些语义，接入真实系统时需实现相应查询和去重机制。

## 完整任务验收

```sh
npm run check
npm run check:examples:tools:tasks
npm run check:examples:tools:tasks:package
```

端到端套件包含十项正常任务、十项缓存过期恢复，以及 Redis / Memory / 业务库 / API / SMTP 故障、权限和参数拒绝、文件路径与符号链接检查、代码执行失败、发布重试、取消、计划与结果阶段进程中断。邮件、CRM 与桌面任务还会在实际副作用完成后、Memory 回执写入前被 `SIGKILL`，再由新进程恢复。套件回读业务数据及文件，不以模型声称执行成功作为完成标准。

代码隔离另测超时、宿主模型凭据不传入容器及容器清理。包验收在仓库外安装 npm tarball，以严格 TypeScript、无 paths 别名、运行时导入拦截和十个静默导入验证公开 API 边界，再执行整个任务套件。依赖或真实模型缺失会失败，不跳过相应能力。

验收对象是自带的 HTTP/CRM 参考服务、SMTP 测试邮箱、实际 Chromium 和独立 Electron 桌面应用。邮件仅投递至本地测试收件人 `operations@example.test`。这些结果证明对应工具链路可执行；接入企业 CRM、生产邮箱或其他桌面应用，需要替换应用适配器并针对目标系统验收。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
