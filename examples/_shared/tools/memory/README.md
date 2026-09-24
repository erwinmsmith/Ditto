# Memory task application tools

[中文](README.zh-CN.md) · [Four memory examples](../../../capabilities/memory/README.md)

- `storage.ts`: select SQLite/PostgreSQL/Qdrant and register Redis Context plus database Memory through public Worker factories. The trusted application owns connections, credentials and scope.
- `adapters.ts`: `memory_project` reads a real project file; `memory_publish` atomically publishes the task report. Register with `createInteractionWorker({tools:memoryTools(...)})` and invoke `INTERACTION.ACT.TOOL`.
- `domain.ts`: validate storage permission, admitted preference fields, exact evidence, stage progress and generated messages. A model proposal is neither permission nor an established long-term fact.

Database implementations live in `../storage/`. The host supplies authenticated namespaces. Environment configuration supplies the Qdrant embedding identity and dimensions. Long-term records use `kind=preference`; task checkpoints use `kind=checkpoint`. Both pass through Memory Worker, but only preferences participate in recall.
