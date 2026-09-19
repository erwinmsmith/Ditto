# Worker API 接口文档

[English](README.md) · **简体中文** · [文档地图](../README.zh-CN.md)

| Worker | 详细接口 | 已实现能力 |
| --- | --- | --- |
| INFER | [中文 API](infer.zh-CN.md) · [English](infer.md) | SAMPLE、TRAJECTORY、REFLECT、DELIBERATE、CACHE LOOKUP / WRITE / INVALIDATE |

本目录描述实际可执行的 API。早期节点体系文档保留为设计记录；INFER 的输入、输出、调用及执行语义以这里的接口文档为准。

- [Provider API](providers.zh-CN.md)：统一注册、多供应商协议、流式与工具消息。
- [ReAct Graph 流程](../interaction-runtime.zh-CN.md#react-预定义-graph-流程)：Runtime 层的采样和动作循环。

- [真实调用验证 / Live verification](infer-live-report.md)：内容断言、供应商实际结果和可复现命令。

- [统一配置 / Shared configuration](configuration.zh-CN.md): 根目录 YAML、env 边界、参数与覆盖顺序。
