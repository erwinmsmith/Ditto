# 人工审核应用适配器

`ReviewApplication` 复用 [HumanReviewStore](../human-review-store.ts) 的草稿版本、事务化审批、持久审核送达和发布核对能力，为[人机协作](../../../patterns/human-in-the-loop/README.zh-CN.md)增加请求/来源绑定、最新权限检查、批准版本继续校验和实际产物验证。

`createDemo` 初始化独立任务目录，`ReviewApplication.open` 打开审核业务库；Runtime/storage 关闭后关闭适配器。`decide`、`edit`、`claim` 仅供已认证的应用控制器使用，不属于模型工具。将 `tools`、`output` 传给 `createInteractionWorker`，模型凭证与生产身份不得来自模型参数。

本地策略允许 `example-publisher` 审核发布、`example-triager` 接管升级任务；它是开发示例，不是身份认证。实际发布写入本地文件，外部服务须提供自己的授权与原子幂等契约。详见 [API 文档](../../../../docs/worker-api/human-loop-workflows.zh-CN.md)。
