# Discussion application tools

Register these public `RegisteredTool` definitions with Interaction Worker. Facts, role criteria, citation checks and report files remain application concerns outside Core.

| Tool                                      | Arguments      | Behavior                                                                            |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `debate_authorize`                        | `{}`           | Validate request, source digest and principal policy                                |
| `debate_read_product/finance/reliability` | `{}`           | Return the same facts, role criteria and topic quotes; no other opinions            |
| `debate_save`                             | `{agent,view}` | Validate identity, topic judgments and quotes; persist immutable view and return id |
| `debate_result`                           | `{id}`         | Validate content digest, request binding and criteria                               |
| `debate_materials`                        | `{ids}`        | Read all received views for comparison; reject duplicate roles or incorrect digests |
| `debate_publish`                          | `{report}`     | Revalidate view/comparison/synthesis lineage; persist Markdown/JSON/CSV             |

Invalid views return `INVALID_VIEW` for budgeted Loop retries. Permission, storage and integrity errors propagate. Models cannot supply arbitrary paths, sources or authority. `domain.ts` defines disclosed fixture criteria and comparison/synthesis contracts; `adapters.ts` performs file I/O.

`createDemo` initializes `request.json/sources.json/policy.json`. Replace facts and evaluation criteria for real integrations while retaining independent inputs, dissent, missing-view markers and source checks. The trusted controller assigns roles; these are not independent authenticated identities.

[Complete API and recovery contracts](../../../../docs/worker-api/debate-workflows.md)
