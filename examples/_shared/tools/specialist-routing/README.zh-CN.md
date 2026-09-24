# 专业路由应用工具

通过公开 `RegisteredTool` 注册到 Interaction Worker。领域目录、确定性规则、SQLite 查询、限定代码修复与测试、文件产物都属于应用层。

| 工具                | 参数                  | 契约                                                       |
| ------------------- | --------------------- | ---------------------------------------------------------- |
| `routing_authorize` | `{}`                  | 验证请求、来源及操作者权限                                 |
| `routing_save`      | `{route}`             | 校验分类、意图和门槛，保存不可变路由，返回 routeId         |
| `routing_read`      | `{routeId,role}`      | 验证选中的角色，返回该角色资料                             |
| `routing_execute`   | `{routeId,role,plan}` | 检查请求适配、固定操作、目标和引用，执行任务并保存 receipt |
| `routing_result`    | `{receiptId}`         | 复核 receipt、路由和产物摘要                               |
| `routing_publish`   | `{report}`            | 核对结果并输出 JSON/Markdown 报告                          |

`INVALID_ROUTE/INVALID_PLAN` 进入有限重试，`ROUTE_MISMATCH` 停止专业执行并请求澄清；存储、权限和完整性异常直接失败。任意 SQL、路径和命令不属于参数协议。编程工具只执行 `code-fixture.ts` 定义的已知函数和测试，子进程不继承环境凭证；这不是任意不可信代码沙箱。

`createDemo` 初始化 `request.json/sources.json/policy.json/sales.sqlite/input-code/`。真实接入时在应用适配器中替换数据来源、身份授权和执行服务，并保留同样的结果校验、幂等及测试契约。

[完整 API 与接入边界](../../../../docs/worker-api/specialist-routing-workflows.zh-CN.md)
