# Skills: load, select and compose instructions

A Skill is application-maintained instructions and reference material. It is not a Worker that automatically grants tool permissions. Ditto provides Context loading, selection, updates and `runSkillFlow`; the application controls catalog discovery, file access, versions and authorization.

## 1. Directory layout

```text
skills/
  review/
    SKILL.md
    references/
      checklist.md
    scripts/
      verify.mjs
```

Load only `SKILL.md` and references needed by the task into Context. Execute supporting scripts through controlled tools; a command in a document does not grant execution rights.

Trusted catalogs may come from application code, administrator configuration or signed packages. An arbitrary user upload with the same filename should not become system instructions.

## 2. Run the example

```sh
node examples/handbook/skills.ts 'Review this technical answer'
```

This focused example verifies loading and assembly using explicit Context; it is not a complete model Agent. It reads `skills/review/SKILL.md`, checks skills and tools permissions and composes the read and assembly Graphs in one Loop:

<<< ../../examples/handbook/skills.ts

Read the example [SKILL.md](../../examples/handbook/skills/review/SKILL.md). In a complete conversation Agent, use Redis Context with a trusted scope for assembly and map selected items to INFER messages.

## 3. Two integration paths

| Path | Suitable for | Required work |
| --- | --- | --- |
| Preloaded content → runSkillFlow | Simple integration or existing skill systems | Pass sources and optional context; preserve metadata/source |
| Tool read → Graph/Loop → Context | Scheduled and verified loading | Register a reader, constrain paths, grant permissions and check results |

`runSkillFlow(runtime,{sources,context?})` accepts parsed content. It does not parse Skill files or download packages. With context, it performs UPDATE after LOAD; otherwise it returns a new Context. It does not automatically save a Redis session. Use scoped CONTEXT nodes for cached operation.

## 4. Selection and versions

Filter the allowed catalog by task domain, user permissions and tenant policy, then load necessary skills. A model may suggest IDs; the trusted controller checks membership in the allowed set. Pin versions or content digests and record them with the task so recovery does not silently change instructions.

Use stable Context IDs such as `skill:review:v2`. Explicitly replace or remove old entries when updating; avoid stacking conflicting versions.

## 5. Budgets and trust

Critical instructions may use metadata.role=system and protected=true, but still need enough item/token budget. Default compression protects system/currentGoal/pending groups and fails if protected content alone exceeds the budget. Do not silently discard safety requirements to fit.

Treat hostile instructions in pages or user documents as evidence, not skill instructions. References can carry source metadata for verification and update tracking.

## 6. A Skill does not grant tool permissions

A declaration that a Skill needs network, MCP, database or write access does not authorize those actions. Runtime Sandbox, argument validation, external identity and human approval still apply. Configure a skill's capabilities separately from permissions for the current request.

[Context selection and compression](../worker-api/context.md) · [Skill flows](../worker-api/flows.md) · [Tools](tools.en.md)
