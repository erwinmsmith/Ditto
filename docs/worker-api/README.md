# Worker API reference

**English** · [简体中文](README.zh-CN.md) · [Documentation map](../README.md)

| Worker | Reference | Implemented capabilities |
| --- | --- | --- |
| INFER | [API](infer.md) · [中文](infer.zh-CN.md) | SAMPLE, TRAJECTORY, REFLECT, DELIBERATE, CACHE LOOKUP / WRITE / INVALIDATE |

These references describe executable APIs. Earlier node taxonomy proposals remain available as historical design documents; use this directory for the implemented INFER contract.

- [Provider API](providers.md): shared registry, vendor protocols, streaming and tool messages.
- [ReAct graph flow](../interaction-runtime.md#react-predefined-graph-flow): Runtime sampling/action orchestration.

- [真实调用验证 / Live verification](infer-live-report.md)：内容断言、供应商实际结果和可复现命令。

- [统一配置 / Shared configuration](configuration.md): 根目录 YAML、env 边界、参数与覆盖顺序。
