# 示例共用资源

[全部示例](../README.zh-CN.md)

此目录用于多个示例共用的配置与小型素材。

- [model.ts](model.ts)：模型配置与初始化约定；复用根目录 `ditto.yaml` 与环境变量，不写入凭据或创建第二套配置框架。
- [fixtures/](fixtures/README.md)：共用静态数据；专用素材放在对应示例内部。

Graph、Loop、任务状态转换和核心算法留在各示例中。不要预先增加通用 Agent 框架、插件加载器或示例运行器。

[tools/](tools/README.zh-CN.md)：应用业务工具与第三方适配；显式注册，不进入 Core。

[Context / Memory 存储接入](tools/storage/README.zh-CN.md)：Agent 示例使用 Redis Context 与数据库 Memory；应用状态库独立保存业务事务。后续示例遵循相同存储与端到端验收约定。
