# INFER 真实调用验证 / Live verification

验证日期：2026-09-19。完整机器可读历史见 [infer-live-results.json](infer-live-results.json)，包含修复前失败、预算不足和供应商连接失败；没有删除失败记录。

## 验证结论

| 供应商 / 协议 | 结果 | 范围 |
| --- | --- | --- |
| DeepSeek `deepseek-flash` / OpenAI 兼容 | 既有完整套件 **22/22 通过** | 五种策略、两类内容题、反思、审议、SSE、工具往返、缓存 |
| DeepSeek / Anthropic 兼容 | **3/3 通过** | SAMPLE、SSE、ReAct 工具往返；不是 Claude 原厂验证 |
| 智谱 `glm-4-flash` | 可调用，但未通过内容验收 | 算术与路径题存在错误；ToT 请求曾超时 |
| 智谱 `glm-4.7-flash` | 未通过 | 小预算返回空的截断答案，另一次返回 HTTP 429 |
| OpenAI `gpt-4o-mini` | 未完成 | `UND_ERR_CONNECT_TIMEOUT`，未进入鉴权与生成阶段 |
| Claude / Gemini 原厂 | 未执行 | theta 配置中未发现对应独立凭证；已有离线协议测试，不算真实验证 |

完整 DeepSeek 套件采用 `thinking.enabled`、`reasoning_effort=low`、单次 maxTokens=4096、轨迹 maxSteps=16 / maxTotalTokens=64000。该次 YAML 配置回归累计报告 Token 为 40,126，顺序执行约 144.61 秒；这是该次测试记录，不是性能或费用保证。Token 上限包含供应商内部推理，不仅是最终答案文本。

配置分组调整后补充真实验证：新 `.env` 前缀和 YAML 层级的 SAMPLE、SSE、ToT/GoT 算术检查 **4/4 通过**；补齐 `workers.infer.deliberate` 后，select/merge/consensus/debate、省略 mode/generation 的默认参数调用、ToT/GoT 算术集成检查 **7/7 通过**。这些是追加的定向验证，原始完整套件记录保留。脚本新增 `deliberate/defaults` 后，今后完整运行包含 23 个用例。

## 内容校验

所有策略都从用户 messages 开始，最终 `output.result` 必须是 assistant Message，解析内容后按确定答案断言，不使用另一个 LLM 充当验收评委。

| 策略 | 算术题 | 最短路径题 | 每题模型调用次数 |
| --- | --- | --- | --- |
| CoT | 通过 | 通过 | 2 |
| Long-CoT（YAML rounds=4） | 通过 | 通过 | 4 |
| ToT（breadth=2, depth=2, beamWidth=2） | 通过 | 通过 | 8 |
| GoT（breadth=2, depth=2） | 通过 | 通过 | 6 |
| Self-Consistency（candidates=3） | 通过 | 通过 | 3，无额外模型评委 |

- 算术：3 本笔记本每本 12 元，2 支笔每支 4 元，整单打七五折，支付 50 元。要求且实际得到 `{"total":33,"change":17}`。
- 路径：有向边 A→B=4、A→C=2、C→B=1、B→D=2、C→D=6。要求且实际得到 `{"path":["A","C","B","D"],"cost":5}`。
- REFLECT 的 critique/verify/revise 均识别 `17×23=400` 为错误；revise 返回 `391`。题目、候选与标准由不同字段传入。
- DELIBERATE 的 select/merge/consensus/debate 均返回 `391`；select 必须选择正确候选 ID 并保留其原始 Message。
- SAMPLE 和 TRAJECTORY SSE 都收到公开增量及一个终态，最终答案 `391`。
- ReAct 必须实际调用本地测试工具一次并读取未知码 `ORCHID-731`，不能靠模型猜测；验证 action 参数、观察回填和最终消息。
- CACHE 验证 Message 的写入、读取、失效与失效后未命中。

## 实测推动的修正

1. CoT 从重复改稿改为线性求解与最终消息生成；Long-CoT 增加中间计算阶段。
2. ToT 实现有界广度优先 beam search；较低排名的保留分支能在下一层胜出。GoT 记录多父节点聚合及下一层依赖。
3. 原始 messages 一并传给审议，防止评估过程丢失题目；selectCount 严格控制保留数量。
4. Self-Consistency 对独立最终答案投票，规范化 JSON 键顺序；并列失败而不虚构共识。
5. 供应商可配置 max_tokens/max_completion_tokens；推理与答案共用预算，length 不冒充完整完成。
6. OpenAI 兼容工具历史保留原始 reasoning_content 以支持推理模式往返，且不将其作为公开文本流输出。
7. 根目录配置中的 Provider、默认模型、请求参数、Sandbox 和超时由 Runtime/Worker 共用，不需要重复配置每个 Worker。

离线 `npm run check`：59 项测试、TypeScript 类型检查和构建通过。离线测试还覆盖多分支保留、GoT 合并依赖、投票并列、JSON 等价、流截断、缺失 usage、缓存隔离、超时和并发 Graph 上下文。

## 复现

使用 Node 24。根目录 [.env.example](../../.env.example) 是无密钥模板；本地 `.env` 存放凭证与部署配置并被 Git 忽略。根目录 [`ditto.yaml`](../../ditto.yaml) 管理行为参数，详见 [统一配置 API](configuration.zh-CN.md)。该次完整回归直接读取 YAML，22/22 通过；报告记录有效配置，旧轮次保留原来的参数。

```sh
npm run check
npm run check:infer:live -- --provider deepseek
# Restrict a rerun; failures still exit nonzero and remain in report history.
npm run check:infer:live -- --provider deepseek --cases tot,long-cot --max-tokens 4096
```

默认报告为被 Git 忽略的 `.infer-live-results.json`；用 `--report path` 改位置。`--strategies` 只筛选轨迹策略，`--cases` 可筛选整个套件（例如 sample、reflect、tot/shortest-path）。正式 Node/Provider 不自动重试；脚本也不重试到通过。

这些测试确认当前配置下的执行与指定题目内容正确，不代表任意模型和任意输入都能保证语义正确。供应商错误、超时和模型错误答案会被区分记录。

方法及协议依据：[CoT](https://arxiv.org/abs/2201.11903)、[ToT](https://arxiv.org/abs/2305.10601)、[GoT](https://arxiv.org/abs/2308.09687)、[Self-Consistency](https://arxiv.org/abs/2203.11171)、[DeepSeek 模型与协议](https://api-docs.deepseek.com/)、[Anthropic 兼容接口](https://api-docs.deepseek.com/guides/anthropic_api/)。
