# 验证、评估与安全能力

九个入口使用公开的 `@codesoul-co/ditto/runtime`、`worker/context`、`worker/memory`、`worker/infer` 和 `worker/interaction` API，完成发布材料检查、语义评估、业务权限复核、发布记录写入及报告交付。

| 能力 | 入口 | 默认任务与产物 |
| --- | --- | --- |
| 结果验证 | `schema.ts` | 检查标题、摘要、行动项和证据是否满足发布要求；缺少标题时拒绝发布 |
| 质量评估 | `evaluate.ts` | 按完整性、相关性、清晰度评分，附原文定位和理由；无关行动项未达阈值时拒绝发布 |
| 一致性检查 | `consistency.ts` | 同一指标在两份来源中的数值不一致，输出冲突位置并阻止发布 |
| 权限检查 | `permissions.ts` | 检查可信身份的角色、所属租户和目标租户；只读角色无法发布 |
| 操作风险检查 | `risk.ts` | 根据影响对象数量、可逆性要求人工确认；确认后重新检查策略再执行 |
| 策略检查 | `policy.ts` | 检查发布开关及影响数量上限；禁用发布时拒绝执行 |
| 输入安全检查 | `input-safety.ts` | 标记外部文本中的已知指令注入模式，将材料作为数据处理，禁止其改变工具及授权 |
| 敏感信息识别 | `sensitive-data.ts` | 输出敏感字段的路径和类别；不返回敏感原值 |
| 信息脱敏 | `redaction.ts` | 在模型、Context、Memory、报告及业务写入之前脱敏，发布脱敏材料 |

每个入口都执行完整检查链。默认的拒绝与待确认任务会交付报告，但不会创建发布记录。`createFixture(directory, mode, "valid")` 创建满足规则的合成材料，用于验证允许路径。

## 运行

要求 Node.js 24+、真实文本模型、Redis，以及示例存储适配器依赖。模型通过根目录 `ditto.yaml` 和 `.env` 配置；业务规则没有加入 Core 配置。

```sh
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:validation:schema
npm run example:validation:evaluate
npm run example:validation:consistency
npm run example:validation:permissions
npm run example:validation:risk
npm run example:validation:policy
npm run example:validation:input-safety
npm run example:validation:sensitive-data
npm run example:validation:redaction
```

模块导入不会启动任务。CLI 输出任务目录、判定、证据和报告路径。可以使用 `--checkpoint` 在评估完成后退出，然后通过同一入口的 `--directory <任务目录>` 恢复。每次恢复都会重新读取并验证源文件，复查业务策略；源文件发生变化时必须创建新任务。

`run(runtime, { request, model }, options)` 是每个入口的调用接口，`options` 支持 `signal` 和 `stopAfter: "material" | "assessment"`。完整接线、人工确认及返回类型见 [API 与调用方法](../../../docs/worker-api/validation-workflows.zh-CN.md)。

## 存储、授权与恢复

- Redis 保存经过脱敏的 Context；SQLite `memory.sqlite` 通过 Memory Worker 保存请求指纹、材料、评估和报告检查点。缓存缺失或过期后重建；Redis 或 Memory 不可用时失败，不降级到进程内存。
- 独立的 `business.sqlite` 保存可信业务策略、绑定内容的人工批准和实际发布记录；它不替代 Memory。身份、租户、目标、影响数量、可逆性均由应用控制器提供。
- `validation_commit` 在 SQLite 写事务中重新检查当前策略，并执行发布记录写入。策略修订使旧批准失效；批准不能绕过权限、内容、质量或策略拒绝。
- 同一任务的已成功写入使用幂等记录恢复。重试返回原成功回执，不再次发布；之后撤销权限不会撤回已经发布的记录。业务撤销需要单独操作。
- 原始合成输入仅保留在应用拥有的 `source.json`（0600）中。适配器读取后先脱敏再向 Runtime 返回。业务数据库、Redis、Memory 和报告不保存这些原值；生产部署需为原始输入另设访问和保留策略。

## 检测范围

源数据采用固定结构，未知字段拒绝。敏感识别包含指定的姓名、地址、电话、邮箱和密钥字段，以及文本中的邮箱、中国大陆手机号码和带 `sk-` / `token-` / `secret-` 等前缀的标记。它不覆盖所有国家的个人信息格式、自然语言中的姓名、无标记密码或编码后的秘密；这些规则应按业务扩充，或接入独立 DLP 服务。

输入检测是有限的模式识别，不是完整的提示注入防御。工具名称、发布目标、权限和批准来自可信应用，模型只返回有引用的评估。数值一致性以同名指标为范围，不代表通用事实核验。模型评分可以存在偏差；硬规则优先，低分阻止发布。Sandbox 是协作式工具访问控制，不是操作系统隔离。

## 完整任务验收

```sh
npm run check:examples:validation:tasks:package
```

验收将真实 npm tarball 安装到仓库外，使用无 paths 别名的严格类型检查，阻止私有源码导入，并检查九个入口静默导入。测试真实调用模型、Redis 和 SQLite，验证发布记录和脱敏报告，覆盖允许、拒绝、需确认、可信确认、旧批准、权限变更、跨租户、错误引用、敏感模型输出、缓存过期、服务故障、取消和 SIGKILL 恢复。隐私检查扫描模型/Worker 输入输出、Redis、Memory、业务数据库、WAL 和报告中的合成敏感标记。

结果写入忽略的 `.examples-validation-package-live-results.json`，产物位于 `.examples-validation-tasks/`。此项验收使用 SQLite，不代表 PostgreSQL/MySQL 的运行验收。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
