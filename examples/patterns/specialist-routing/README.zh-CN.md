# 4.13 专业 Agent 路由

**用户请求 → 主 Agent 判断领域 → 检查角色权限与置信度 → 专业 Agent 复核任务范围 → 执行专业工具 → 校验结果并作答**

提供财务报销计算、合成合同检查、SQLite 销售汇总、折扣函数修复四条完整路径。专业角色使用独立 Context 和限定资料；无匹配、多领域和低置信度请求提出澄清，不执行专业操作。模型选错角色时，专业角色还能报告范围不匹配。

一个主 Loop 组合公开 Worker Graph，Context 使用 Redis，Memory 使用文件 SQLite，业务工具位于 `_shared/tools/specialist-routing`。需要 Node 24、真实 Redis、已配置模型和环境凭证。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:specialist-routing -- --provider deepseek --scenario finance
npm run example:specialist-routing -- --provider deepseek --scenario legal
npm run example:specialist-routing -- --provider deepseek --scenario data
npm run example:specialist-routing -- --provider deepseek --scenario coding
npm run example:specialist-routing -- --provider deepseek --scenario ambiguous
npm run example:specialist-routing -- --provider deepseek --stop-after route
npm run example:specialist-routing -- --provider deepseek --directory .examples-specialist-routing-tasks/cli-XXXXXX
npm run check:examples:specialist-routing:package -- --provider deepseek
```

恢复时使用任务打印的实际目录。产物位于已忽略的 `.examples-specialist-routing-tasks/`：数据路径输出 CSV，编程路径输出修复文件与实际测试日志，各路径输出操作 receipt 和 JSON/Markdown 报告。财务仅计算、不付款；法务使用内部检查表，不形成法律意见。

[完整 API、契约与调用](../../../docs/worker-api/specialist-routing-workflows.zh-CN.md) · [应用工具](../../_shared/tools/specialist-routing/README.zh-CN.md) · [English](README.md)
