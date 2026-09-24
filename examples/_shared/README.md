# Shared example resources

[简体中文](README.zh-CN.md) · [All examples](../README.md)

Use [model.ts](model.ts) for shared model configuration and [fixtures/](fixtures/README.md) for small common inputs. Keep orchestration and task logic in each example.

[tools/](tools/README.md): application business tools and third-party adapters, explicitly registered outside Core.

[Context / Memory storage](tools/storage/README.md): Agent examples use Redis Context and database Memory, with separate business state. Subsequent examples follow the same storage and end-to-end verification contract.
