# 工具操作适配器

[English](README.md) · [应用工具](../README.zh-CN.md) · [十项任务](../../../capabilities/tools/README.zh-CN.md)

本目录提供应用侧 `RegisteredTool` 实现。Ditto Core 负责 Graph、原生模型工具调用、工具注册和结果观察；浏览器、桌面、SMTP、HTTP、业务 SQL 和代码执行均由这里的适配器实现。SDK 与业务策略不进入 Core 依赖或 YAML 配置模型。

## 环境准备

在仓库根目录使用 Node.js 24+：

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/operations/dependencies
node examples/_shared/tools/operations/dependencies/node_modules/electron/install.js
examples/_shared/tools/operations/dependencies/node_modules/.bin/playwright install chromium
docker pull node:24-bookworm-slim
```

启动 Docker 和 Redis，在 `.env` 设置 `DITTO_WORKER_CONTEXT_REDIS_URL` 及真实模型凭据；配置方法见 [共享配置](../../../../docs/worker-api/configuration.zh-CN.md)。Electron 桌面任务需要可用图形会话，验收会检查原生窗口可见性。无图形会话的 CI 应提供桌面显示服务，不能将桌面任务替换为 HTTP 请求。

依赖锁文件固定 Playwright、Electron、Nodemailer 与 smtp-server。`sdk.ts` 延迟加载 SDK，导入任务文件不会启动服务、打开窗口、发送邮件或调用模型。消费者安装这些依赖并复制适配器及桌面资产；Core npm 包不自动加载或分发这些应用工具。

## 适配器职责

| 文件 | 职责 |
| --- | --- |
| [domain.ts](domain.ts) | 工具 schema、控制器允许列表、参数和业务回执校验 |
| [adapters.ts](adapters.ts) | 绑定 SQL、受限 HTTP、文件读写、容器执行、网页/桌面操作、消息与系统写入 |
| [sdk.ts](sdk.ts) | 应用 SDK 延迟加载端口 |
| [desktop.cjs](desktop.cjs) | Electron 主进程、受限保存 IPC、持久化读写 |
| [desktop-preload.cjs](desktop-preload.cjs) | 仅暴露保存操作的隔离桥 |
| [desktop.html](desktop.html) / [desktop-renderer.js](desktop-renderer.js) | 可输入、点击保存的桌面表单 |
| [fixtures.ts](../../../capabilities/tools/fixtures.ts) | 独立 SQLite 业务数据、HTTP/CRM 服务和 SMTP 接收服务 |

`OperationAdapters(directory, request).tools` 返回工具注册表，包括当前任务可用工具及仅供流程发布产物的 `operation_publish`。将它传给 `createInteractionWorker`；通过 Runtime 执行，不直接调用适配器完成 Agent 流程。应用结束时关闭 Runtime、适配器数据库、Memory/Redis 连接和参考服务。

`authorized`、任务 ID、租户、目标系统和收件人由可信控制器提供。模型不能修改这些字段；模型返回的工具名和参数在调用前及工具边界内分别校验。`effects` 只是副作用描述，不表示授权。

## 执行约束

HTTP 工具限定为控制器指定 origin，拒绝重定向，设置 5 秒超时并限制响应为 64 KiB。浏览器仅放行同一 origin 的请求并禁用 Service Worker。文件工具固定工作目录内的输入/输出文件名，拒绝草稿符号链接；不可变输出发生内容冲突时失败。

生成代码在 Docker 中执行：无网络、无宿主挂载、只读根文件系统、非 root 用户、删除 capabilities、禁止提权，并限制 CPU、内存、进程数、输出长度及 12 秒执行时间。`new Function` 只在容器内解析函数体，隔离边界是容器。不会回退到宿主 `eval` 或 `vm`。`DITTO_EXAMPLE_CODE_IMAGE` 可由可信部署配置替换为预先审核并拉取的 Node.js 镜像。

桌面应用启用 context isolation、renderer sandbox、禁用 Node integration 和外部导航，只暴露保存便笺的 IPC。桌面截图和保存内容均位于任务目录，不操作现有用户文档。

参考 SMTP 绑定 loopback，仅接受 `operations@example.test`，不连接互联网邮件服务。Message-ID 去重与邮箱查询属于参考服务能力；替换服务时保留接收端核对或引入供应商幂等机制，不能将普通 SMTP 的成功响应视为所有重试均只发送一次的保证。

CRM 参考服务通过 HTTP PATCH 更新独立业务库，以任务 ID 为幂等键，并在同一事务内保存结果。连接中断后先查 `/operations/:id` 再决定是否重试。接入真实 CRM/ERP/工单系统时，替换端点、认证和业务校验；保持相同的公开 Worker 组合方式。

Docker 执行与不可变文件工具复用 [execution](../execution/README.md)；复制应用工具到消费项目时同时复制该目录。原 `adapters.ts` 导出路径保持兼容。
