# Supervisor 应用工具

`domain.ts` 定义角色、资料结构、下一步分配资格、审核结果绑定和结论规则；`adapters.ts` 读取实际限定资料，验证专业结果与父子关系，保存不可变交接，并在交付报告前重放管理历史。复用 multi-agent 的资料辅助函数，不执行另一个工作流。

通过 Interaction 注册 `sup_authorize`、`sup_read_engineering`、`sup_read_operations`、`sup_read_verification`、`sup_save`、`sup_result`、`sup_publish`。核验必须提供已有工程阻塞结果 ID，不能仅凭模型请求读取复测记录。工具不运行测试、不修改外部系统，也不授权部署。

`createDemo(directory,overrides,scenario)` 初始化隔离示例；`SupervisorAdapters(directory,request)` 不创建后台连接。Runtime 复用 [Redis/SQLite 适配器](../storage/README.zh-CN.md)。认证身份和资料归属由可信应用负责。参见[调用契约与恢复](../../../../docs/worker-api/supervisor-workflows.zh-CN.md)。
