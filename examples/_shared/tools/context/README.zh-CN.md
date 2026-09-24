# 上下文任务工具

[English](README.md) · [示例](../../../capabilities/context/README.zh-CN.md)

`contextTools(directory,request)` 返回三个公开 `RegisteredTool`：

- `context_document`：按控制器指定的 initial/revision 版本读取目录中的 JSON 文档，校验发布字段并携带文件 URI。
- `context_search`：查询控制器准入的 HTTP 来源，限制大小、时间与重定向，核对请求标识和返回区域。
- `context_publish`：将已验证的报告发布到 `artifacts/brief.json`，采用临时文件加原子链接；相同内容可重复提交，不覆盖不同内容。

通过 `createInteractionWorker({tools})` 注册并由 `INTERACTION.ACT.TOOL` 调用。目录、租户、URL 由可信宿主提供。`domain.ts` 是发布交接业务校验，不属于 Core 能力。存储连接配置复用相邻的 `storage/` 目录；本目录不提供另一套 Memory 或 Context 存储。
