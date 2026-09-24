# 多观点讨论应用工具

这些工具通过公开 `RegisteredTool` 注册到 Interaction Worker。事实来源、角色标准、引用校验和报告文件属于应用层，不进入 Core。

| 工具                                      | 参数           | 行为                                                           |
| ----------------------------------------- | -------------- | -------------------------------------------------------------- |
| `debate_authorize`                        | `{}`           | 核对请求、资料摘要和操作者权限                                 |
| `debate_read_product/finance/reliability` | `{}`           | 返回同一事实快照、该角色标准和按主题组织的引用；不返回其他观点 |
| `debate_save`                             | `{agent,view}` | 验证身份、维度判断和原文引用，保存不可变观点并返回 id          |
| `debate_result`                           | `{id}`         | 校验观点内容摘要、请求绑定和标准                               |
| `debate_materials`                        | `{ids}`        | 为汇总读取全部已接收观点；拒绝重复角色和错误摘要               |
| `debate_publish`                          | `{report}`     | 复核观点、比较和综合来源链，保存 Markdown/JSON/CSV             |

无效观点返回 `INVALID_VIEW`，由 Loop 按预算重试。权限、存储和完整性异常直接失败。工具不接受模型指定的路径、来源或额外授权。`domain.ts` 定义公开演示标准和比较/综合契约，`adapters.ts` 负责实际文件读写。

`createDemo` 初始化 `request.json/sources.json/policy.json`。实际接入时替换事实来源和评估标准，保留独立输入、少数意见、缺失标记及来源校验。角色标识由可信控制器分配，并非独立认证身份。

[完整 API 与恢复契约](../../../../docs/worker-api/debate-workflows.zh-CN.md)
