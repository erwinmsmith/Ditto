# Research application tools

[中文](README.zh-CN.md) · [Complete example](../../../patterns/deep-research/README.md)

`domain.ts` validates trusted requests, subquestions, coverage, budgets and reports. `adapters.ts` reuses `WebAdapters` search, HTML reading, snapshots and citation checks, adding research authorization and Markdown/JSON publication. Dependencies remain in application tools, outside Core.

`createTask` binds immutable requests and policies. Register `ResearchAdapters.tools` with the public Interaction Worker: `web_search`, `web_read`, `web_check`, `research_authorize`, `research_publish`. Both research and web policies are checked on each access. Models cannot grant permission, expand origins or raise budgets.

Configuration reuses [web search](../web-search/README.md) and [storage](../storage/README.md). The controller supplies authenticated identity, isolated directories and one active runner per task. Test loopback/proxy switches are explicit and do not replace production policy.

Publication validates the report and citations against saved HTML, then idempotently writes `output/report.md` and `output/report.json`. Database Memory owns workflow progress; tool caches do not replace it. See [research APIs](../../../../docs/worker-api/research-workflows.md) for budgets, recovery and source limitations.
