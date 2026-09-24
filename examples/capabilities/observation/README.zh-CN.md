# 执行结果理解

[English](README.md) · [基础能力](../README.zh-CN.md) · [API 调用指南](../../../docs/worker-api/observation-workflows.zh-CN.md)

五个入口通过公开 Runtime / Graph API，将真实工具结果转成可验证的理解、任务状态与后续动作。流程组合 `INTERACTION.ACT.TOOL`、`INTERACTION.OBSERVE`、`INFER.REASONING.SAMPLE`、`CONTEXT.*` 与 `MEMORY.*`。HTTP 服务、输出解析规则和业务状态工具位于 [应用工具目录](../../_shared/tools/observation/README.zh-CN.md)。

| 能力 | 入口 | 完整任务 |
| --- | --- | --- |
| 工具结果读取 | [read.ts](read.ts) | 读取 HTTP 工具的结构化订单结果，保留调用标识、来源与证据，核对金额并交付报告 |
| 执行结果解析 | [normalize.ts](normalize.ts) | 读取实际 CSV 原文，由模型提取订单、数量、单价与状态，校验计算值并写出结构化结果 |
| 错误识别 | [errors.ts](errors.ts) | 识别实际 HTTP 503，保存可重试状态，执行一次幂等重试，再核对结果 |
| 状态更新 | [state.ts](state.ts) | 根据已验证的远端结果更新任务状态、版本和事件记录，同步 Redis 与数据库 Memory |
| 后续动作判断 | [interpret.ts](interpret.ts) | 接口超时后先查询远端状态，确认业务已经完成，再结束任务，避免重复提交 |

## 运行

需要 Node.js 24+、已配置的真实模型和可用 Redis：

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
```

在根目录 `.env` 配置模型凭据与 `DITTO_WORKER_CONTEXT_REDIS_URL`；模型选择使用 `ditto.yaml`。本模块的 HTTP 与 SQLite 适配器使用 Node.js 标准库，不新增第三方 SDK。

```sh
npm run example:observation:read
npm run example:observation:normalize
npm run example:observation:errors
npm run example:observation:state
npm run example:observation:interpret
```

每次运行生成 `.examples-observation-tasks/cli-*` 目录并打印路径。交付文件 `artifacts/result.json` 包含每轮原始 `ExternalResult`、标准 `Observation`、模型解释和最终任务状态。`verified: true` 表示结果与解释已校验；是否完成业务目标应读取 `state`，不能将 `needs_review` 或 `stopped` 当成 `completed`。

在第一轮解释已保存、尚未更新业务状态时暂停，随后用输出目录恢复：

```sh
npm run example:observation:errors -- --checkpoint
npm run example:observation:errors -- --directory .examples-observation-tasks/cli-XXXXXX
```

`--provider <name>` 可选择配置中的模型。恢复需要原任务目录、原输入和可用的原 HTTP 端口；输入变更必须创建新任务 ID。

## 结果与动作规则

| 实际证据 | 错误分类 | 动作 / 任务状态 |
| --- | --- | --- |
| 完整且匹配订单的成功 JSON / CSV | `none` | 完成 / `completed` |
| HTTP 503 | `transient` | 重试一次 / `waiting_retry` |
| HTTP 403 / 404 | `permission` / `not_found` | 转交核查 / `needs_review` |
| 超时 / 连接中断 | `timeout` / `transport` | 查询远端状态 / `reconciling` |
| HTTP 成功但业务状态为 failed | `business` | 转交核查 / `needs_review` |
| 缺字段、内容损坏、订单不匹配或金额无效 | `invalid_output` | 转交核查 / `needs_review` |
| 远端明确取消 | `cancelled` | 停止 / `stopped` |
| 一次后续操作后仍未解决 | 保留对应分类 | 不再继续操作 / `needs_review` |

模型读取真实 Observation，不接收预设解释作为答案。应用根据原始证据验证字段、计算值、调用标识和动作；模型编造金额或提出不允许的动作时，不更新任务状态、不发布报告。工具输出仅作为数据，不能授予权限。转交核查表示持久化待处理状态及证据报告，不自动向其他人发送消息。

## 持久化和恢复

- **Context**：真实 Redis，按租户和任务隔离；使用 `CONTEXT.UPDATE` 写入当前观察与任务状态。
- **Memory**：独立 `memory.sqlite`，通过 `MEMORY.GET/WRITE` 保存输入、每轮观察、已验证解释和最终报告。Redis 缓存过期可重建，服务不可用则失败。
- **任务状态**：独立 `tasks.sqlite`，事务保存状态、版本和事件；重复提交同一轮不会重复更新，冲突提交会失败。
- **远端系统**：独立 HTTP 服务及 `remote.sqlite`，实际记录请求、业务状态和重试次数。任务库不能替代 Memory Worker。

观察先保存，再调用模型；解释先保存，再更新状态及选择后续工具。远端重试采用固定幂等键，超时与未知结果先核对业务状态。取消或超时不承诺回滚已发生的外部操作。发布失败可从已归档报告重试。

## 完整任务验收

```sh
npm run check
npm run check:examples:observation:tasks
npm run check:examples:observation:tasks:package
```

32 个场景覆盖五项正常任务、五项 Redis 过期恢复、十种真实 HTTP / 输出结果，以及存储不可用、模型错误解释、取消、发布重试和输入冲突。跨进程测试在观察、解释提交后，以及状态更新、远端重试实际生效后发送 `SIGKILL`，再恢复并核对数据库、版本、业务重试次数与交付文件。

包验收在仓库外安装 npm tarball，通过无 paths 别名的严格类型检查、私有导入拦截与五个静默导入后，执行完整任务套件。真实模型、Redis 或数据库缺失会报错，不跳过用例。验收使用本模块自带的真实 HTTP 参考服务和 SQLite，不表示已验证任意生产系统或其他数据库。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
