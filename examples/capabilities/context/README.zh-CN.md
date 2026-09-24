# 3.5 上下文能力

[English](README.md) · [能力目录](../README.zh-CN.md) · [API 与调用方式](../../../docs/worker-api/context-workflows.zh-CN.md)

以发布交接任务演示五种上下文操作。每个入口通过公开 `@ditto/core` Worker 和 Runtime Graph 执行，使用 Redis 工作上下文、SQLite Memory 会话历史与检查点，调用真实模型生成 `artifacts/brief.json`。

| 入口 | 输入与执行 | 结果 |
| --- | --- | --- |
| [load.ts](load.ts) | `MEMORY.GET` 读取历史；工具读取发布文档；`CONTEXT.LOAD({scope,sources})` 装入指令、目标、文档、历史 | 从完整上下文生成交接单 |
| [select.ts](select.ts) | `CONTEXT.SELECT({scope,purpose:"infer",query,limit:5})` 选择指令、目标及当前步骤所需事实 | 5 个输入条目；Redis 中仍保留全部 23 个条目 |
| [assemble.ts](assemble.ts) | `LOAD` 初始化指令与目标；`UPDATE` 组合文档、数据库历史及实际 HTTP 搜索结果，保留来源 | 使用搜索结果中的部署区域，生成带引用的交接单 |
| [compress.ts](compress.ts) | `INFER` 总结历史；校验决策与原文引用；`UPDATE` 写入摘要；`COMPRESS({scope,maxItems:4})` 删除剩余闲聊 | 23 个条目压缩为指令、目标、文档、摘要，负责人和预算不丢失 |
| [update.ts](update.ts) | 生成初始交接单；读取修订文档；`UPDATE` 以相同 ID 替换旧版本；再次推理 | 交接单采用新的区域和发布比例，并保留前后结果 |

## 运行

需要 Node.js 24+、Redis、配置在 `ditto.yaml` 与 `.env` 中的真实模型。SQLite 使用 Node 内置驱动；Redis SDK 由应用单独安装。

```bash
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:context:load
npm run example:context:select
npm run example:context:assemble
npm run example:context:compress
npm run example:context:update
```

默认 CLI 在 `.examples-context-tasks/` 创建随机任务、输入文件及本地 HTTP 搜索服务。搜索服务是可重复运行的外部来源样例，不代表公网搜索引擎；替换供应商时在应用工具中接入，保持来源校验和网络许可。真实会话历史通过 `MEMORY.WRITE` 导入数据库，工作检查点使用独立的 `context:<tenant>:<task>:<stage>` 命名空间，不作为内部知识库记录。

```bash
# 在 ready 检查点停止，输出目录用于下一次调用
npm run example:context:compress -- --checkpoint
# 使用上一步输出的实际目录继续
npm run example:context:compress -- --directory .examples-context-tasks/cli-XXXXXX
```

`--directory` 从 `request.json` 和数据库恢复；尚未完成组装且需重启演示搜索服务时加 `--serve-fixture`。一个任务 ID 对应固定请求与已提交输入快照；修改请求应创建新 ID。用户业务调用可导入任一入口的 `run(runtime,{request,model},options)`；导入不启动服务或执行任务。

## 恢复与边界

- 仅 `CONTEXT_NOT_FOUND` 触发从数据库检查点恢复；Redis 或 Memory 不可用时明确失败。
- 检查点保存完整的已提交工作集及选择视图，恢复不会将旧文档或完整历史覆盖到新版本、摘要上。报告先写 Memory，再发布文件；文件写入失败可重试而不再次调用模型。
- `SELECT` 是视图，不修改缓存；应用在推理前检查指令和目标仍然存在。默认选择与预算不是权限控制器。
- `COMPRESS` 是确定性裁剪；语义总结由显式模型调用完成。摘要必须保留批准的负责人、预算与逐字证据，否则禁止提交。受保护条目无法满足预算时失败，不丢弃指令。
- 示例的摘要与输出校验针对发布交接字段；其他业务应提供各自的保真校验。默认 token 估算不是供应商的精确 tokenizer。
- 每个任务使用一个活动控制器。Redis CAS 保护单次状态写入；数据库与 Redis 没有跨服务事务，应用通过已提交检查点恢复。多个控制器争用同一任务应由宿主加任务锁，不可据此宣称业务操作 exactly-once。
- 文档、搜索结果和历史作为数据传入，不提升为系统指令；租户身份、目录和搜索 URL 由可信宿主传入。作用域键隔离不替代权限认证。

## 验收

```bash
npm run check
npm run check:examples:context:tasks
npm run check:examples:context:tasks:package
```

任务验收检查真实模型输出、文件产物、Redis TTL、数据库记录、五类上下文过期恢复、跨进程 SIGKILL 恢复、数据库与 Redis 故障、预算不足、摘要证据错误、CAS 冲突及发布重试。模型故障注入先完成真实调用，再破坏返回值以验证拒绝路径。

包验收将 npm tarball 安装到仓库外，执行无 paths 别名的严格类型检查、五个入口的静默导入及模块边界检查，再完成全部任务实验。测试产物、SQLite、日志和 `AGENTS.md` 均由 Git 忽略。此验收使用 SQLite，不等同于 PostgreSQL/MySQL 验收。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
