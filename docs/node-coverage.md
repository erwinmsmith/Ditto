# Ditto Node Coverage and Case Mappings

**English** · [简体中文](node-coverage.zh-CN.md)

This guide remaps the six existing test cases to the [Node Taxonomy and API Contract](13-node-api-contract.md). Cases use only the agreed target semantic names and do not claim that current dev already implements them.

Tasks and delivery constraints follow the supplied Node Coverage document. Every case uses the same presentation: case title, Task heading, task prose, then an Order/Node/Operation table. Case One's 23 rows come from the newly supplied full screenshot. The other cases retain the 10, 10, 10, 10, and 8 rows visible in the source document; no missing spreadsheet rows are invented. Completion, scores, and logs remain properties of the original test records.

## Classification Rules

| Original label or behavior | Current ownership | Mapping requirement |
| --- | --- | --- |
| CONTEXT.PROMPT | Graph bind or application input assembly | Use CONTEXT.LOAD/UPDATE only when loading or changing actual context; use CONTEXT.SKILL only to fetch a registered Skill. |
| CONTEXT.SCHEDULE | Application composition and existing context/memory operations | MEMORY.WRITE/UPDATE persist knowledge; CONTEXT.SELECT/COMPRESS select or compress working context. There is no same-name Node. |
| INTERACTION.MCP | INTERACTION.ACT.MCP | MCP discovery or invocation is a distinct semantic Node; client connection, authentication, and session lifecycle remain in the application/Runtime. |
| Receiving a task or question | Application/Runtime input boundary | Task parameters enter before Graph execution. This is not a Node; an actual external messaging service may be called through ACT.TOOL or ACT.MCP. |
| Choosing a retrieval route labeled CONTEXT.SELECT | INFER.REASONING.DELIBERATE | Comparing candidate plans is deliberation; SELECT filters supplied Context items using query. |
| Any history file or business database labeled MEMORY.RETRIEVE | Classify by addressing and lifecycle | Use MEMORY.RETRIEVE for known id/key/filter reads, MEMORY.RAG.RETRIEVE for semantic recall, and ACT.TOOL/MCP for temporary files or live business state. |
| ACT and TOOL shown at the same level | `ACT` is a namespace | Use `INTERACTION.ACT.TOOL` for directly registered tools and `INTERACTION.ACT.MCP` for MCP capabilities; ACT is not an executable leaf. |
| Evaluation, approval, retry, and cost accounting | Test-side or application policy | No new Nodes. Actual verifier-tool calls may use TOOL/ACT; reasoning and prompts do not replace authorization checks. |

Cases must not insert behavior merely to cover all 25 target Node Types. The former `INTERACTION.RUN` is application Graph / Runtime orchestration rather than a Node, and one composite loop cannot replace trace evidence for the leaf Nodes actually invoked.

## Final RAG Mappings

| Operation | Existing Nodes | Boundary |
| --- | --- | --- |
| Acquire web, file, or third-party material | `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP` | External capability call; acquired data may become a current-task corpus. |
| Retrieve current-task knowledge | `CONTEXT.RAG.EMBED/RETRIEVE/RANK` | Search current documents, repositories, web sources, knowledge bases, or temporary corpora and feed working context. |
| Directly read a durable item | `MEMORY.RETRIEVE` | Address by id, key, filter, or another structured selector. |
| Semantically retrieve durable memory | `MEMORY.RAG.EMBED/RETRIEVE/RANK` | Search a Memory Corpus that survives invocations or sessions. |
| Manage durable-state lifecycle | `MEMORY.WRITE/UPDATE/CONSOLIDATE/EVICT` | Create, modify, organize, and evict persistent semantic state. |
| Reason over evidence and deliver an answer | `INFER.REASONING.*`; `INTERACTION.OUTPUT` | RAG does not own generation; the selected reasoning Node performs the model call. |

Exact inputs and outputs are defined by the API Contract. These cases establish semantic ownership and do not invent CACHE leaves or extra RAG stages.

## Case One SWE-bench Code Repair

### Task

Select a real GitHub Issue from SWE-bench Verified and load the repository at the corresponding commit. The Agent locates the defect, modifies code, runs tests, and submits a patch with verification evidence.

All changes occur in a disposable container or temporary worktree and are not pushed to the real GitHub repository.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | Receive the Issue description, repository version, and delivery requirements before Graph execution; this boundary is not a Node. |
| 2 | CONTEXT.LOAD | Load the Issue, repository tree, baseline commit, and test commands. |
| 3 | MEMORY.RAG.RETRIEVE | Semantically retrieve repository conventions, known build problems, and prior repair experience from the long-term Memory Corpus. |
| 4 | CONTEXT.SELECT | Select loaded evidence related to the stack trace, symbols, and modules. |
| 5 | CONTEXT.SKILL | Retrieve registered repair constraints such as minimal edits and no test bypass; use Graph bind when no Skill is registered. |
| 6 | INFER.REASONING.TRAJECTORY | Form the first defect hypothesis. |
| 7 | INTERACTION.ACT.TOOL | Use registered code search, file read, and Git diff tools. |
| 8 | INTERACTION.OBSERVE | Receive symbol references, call paths, and current implementation details. |
| 9 | CONTEXT.UPDATE | Add new call relationships to working context. |
| 10 | INFER.REASONING.SAMPLE | Generate count repair candidates, including boundary, state, and interface fixes. |
| 11 | INFER.REASONING.DELIBERATE | Compare compatibility, impact, and regression risk. |
| 12 | INTERACTION.ACT.TOOL | Edit selected files and run target tests. |
| 13 | INTERACTION.OBSERVE | Receive failures, stack traces, coverage, or lint results. |
| 14 | INFER.REASONING.REFLECT | Compare results with the original hypothesis and explain why the repair failed. |
| 15 | CONTEXT.COMPRESS | Reduce long logs to failing assertions, affected files, and key variables. |
| 16 | CONTEXT.UPDATE | Update repair state with compressed evidence. |
| 17 | INTERACTION.ACT.TOOL | Modify again, then run target and regression tests. |
| 18 | INTERACTION.OBSERVE | Receive final test results and Git diff. |
| 19 | MEMORY.WRITE | Persist a task memory containing problem, root cause, repair, and test evidence. |
| 20 | MEMORY.CONSOLIDATE | Merge repeated failure experience into one repository-level memory. |
| 21 | MEMORY.WRITE | Persist full logs or a log Reference; the final diff and summary remain in context from steps 15–16. |
| 22 | MEMORY.EVICT | Evict low-value temporary search results and expired hypotheses. |
| 23 | INTERACTION.OUTPUT | Deliver the patch, change explanation, test results, and remaining risks. |

Delivery and validation: the edits and tests required by the task prose execute through registered TOOL handlers; OUTPUT delivers results. The patch, baseline commit, commands, and actual test outputs provide evidence. An INFER message claiming success is not a test result.

## Case Two GAIA Multi-source Investigation

### Task

Select a public-validation question requiring web search, attachment reading, and numerical calculation. Deliver the exact answer with sources, a calculation summary, and conflict-handling records.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | Receive the question, attachments, and answer format before Graph execution; this boundary is not a Node. |
| 2 | CONTEXT.LOAD | Load the question, files, date constraints, and evaluation format. |
| 3 | CONTEXT.UPDATE | Add source priority, citation requirements, and no-guessing rules to context. |
| 4 | INFER.REASONING.TRAJECTORY | Decompose facts to verify and calculation steps. |
| 5 | INFER.REASONING.SAMPLE | Generate count retrieval routes and keyword combinations. |
| 6 | INFER.REASONING.DELIBERATE | Compare candidates and choose a retrieval plan. |
| 7 | INTERACTION.ACT.TOOL | Invoke web search, browser, PDF, or spreadsheet tools. |
| 8 | INTERACTION.OBSERVE | Receive pages, documents, tables, and source information. |
| 9 | CONTEXT.UPDATE | Add sources, dates, facts, and confidence to context. |
| 10 | CONTEXT.RAG.RANK | Rerank candidates by source authority, date, and evidence completeness, lowering reposts and unsupported snippets. |

Delivery and validation: calculations use configured tools; OUTPUT delivers the answer and sources. Official answer comparison belongs to the test harness. Public web search is not automatically long-term Memory retrieval; record Memory calls only when the existing test actually uses persistent knowledge.

## Case Three τ²-bench Customer Transactions

### Task

Select an Airline or Retail order, booking, refund, or exchange task. Communicate with the user simulator, read policy and customer state, and change the sandbox database only after conditions are met.

The case distinguishes authority to propose an operation from authority to execute it.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | Receive the cancellation, rebooking, refund, or exchange request before Graph execution; this boundary is not a Node. |
| 2 | CONTEXT.LOAD | Load the dialogue, domain, and available-tool descriptions. |
| 3 | MEMORY.RAG.RETRIEVE | Semantically retrieve customer-interaction experience from the long-term Memory Corpus; live customer records still use ACT.TOOL. |
| 4 | INTERACTION.ACT.TOOL | Query customer, order, flight, or product state. |
| 5 | INTERACTION.OBSERVE | Receive real sandbox business records. |
| 6 | CONTEXT.UPDATE | Add order state, amounts, times, and identity information to context. |
| 7 | CONTEXT.SKILL | Retrieve registered refund policy and approval boundaries; tools and Sandbox still enforce permissions. |
| 8 | INFER.REASONING.TRAJECTORY | Identify the requested transaction type. |
| 9 | INFER.REASONING.DELIBERATE | Check policy, fees, eligibility, and mutually exclusive operations. |
| 10 | CONTEXT.SELECT | Keep the customer and policy fields needed for the decision. |

Delivery and validation: the application channel handles confirmation or clarification; an actual external messaging integration uses ACT.TOOL or ACT.MCP. After authorization, ACT.TOOL performs the change. Validate sandbox final state and official results; advice, confirmation messages, and context updates are not executed refunds.

## Case Four MCPMark Verified Cross-system CRUD

### Task

Select an official GitHub, Notion, Filesystem, Postgres, or Playwright task. Discover MCP capabilities, then query, create, update, associate, or delete.

Use the officially published task and verifier rather than a simplified substitute.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | Receive the task and permitted MCP server scope before Graph execution; this boundary is not a Node. |
| 2 | CONTEXT.LOAD | Load initial state and verifier conditions. |
| 3 | INTERACTION.ACT.MCP | Discover task capabilities through MCP; client connection, authentication, and session lifecycle remain in the application/Runtime. |
| 4 | INTERACTION.OBSERVE | Feed capabilities, parameter schemas, and resource descriptions into the Agent observation stream. |
| 5 | CONTEXT.SELECT | Select the minimum loaded capability descriptions; ToolRegistry and Sandbox enforce actual access. |
| 6 | CONTEXT.UPDATE | Add forbidden scope, idempotency, and deletion approval rules to context. |
| 7 | MEMORY.RAG.RETRIEVE | Retrieve historical service failures and parameter limits from the long-term Memory Corpus; an actual experience store is required. |
| 8 | INFER.REASONING.SAMPLE | Form multiple cross-tool plans. |
| 9 | INFER.REASONING.DELIBERATE | Compare side effects, call count, and rollback difficulty. |
| 10 | INTERACTION.ACT.MCP | Invoke the read-only MCP capability; exact protocol fields are fixed by the later Contract. |

Delivery and validation: subsequent CRUD calls also use TOOL. The official verifier belongs to the test harness, counted as TOOL only if actually wrapped and invoked as one. Core does not guarantee transactions, rollback, or approvals. Applications supply the MCP SDK connection without creating a MCP Node.

## Case Five LongMemEval-V2 Long-term Memory

### Task

Load historical Web/Enterprise Agent traces from LongMemEval-V2. Build persistent memory across turns while handling new facts, overwritten facts, environment pitfalls, and irrelevant information, then answer official questions.

The case targets the complete Memory lifecycle.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | CONTEXT.LOAD | Load the first historical traces in time order. |
| 2 | CONTEXT.SELECT | Select facts, state changes, workflow experience, and environment pitfalls. |
| 3 | INFER.REASONING.TRAJECTORY | Determine content worth remembering. |
| 4 | MEMORY.WRITE | Persist first-seen stable facts or experience and retain returned IDs. |
| 5 | INFER.REASONING.DELIBERATE | Decide whether information remains in context, becomes new memory, or updates existing memory. |
| 6 | CONTEXT.COMPRESS | Compress traces into a memory summary with source references. |
| 7 | CONTEXT.LOAD | Load subsequent traces. |
| 8 | INTERACTION.OBSERVE | Feed traces into the environment-history observation stream. |
| 9 | INFER.REASONING.DELIBERATE | Decide whether new information supplements, replaces, conflicts, or is noise. |
| 10 | MEMORY.UPDATE | Update old state using existing IDs and retain time/source data in Message.content. |

Delivery and validation: the full-lifecycle goal also requires retrieval, consolidation, and eviction records, mapped to RETRIEVE, CONSOLIDATE, and EVICT. Count coverage only when actual operations have inputs, returned IDs, and subsequent visible-state evidence; the case name or goal does not establish 5/5 validation. Record official QA scores separately from additional lifecycle assertions. INFER and OUTPUT generate and deliver answers.

## Case Six AFlow MATH Audit and Smoke Test

### Task

Inspect the AFlow MATH reproduction and verify best-round selection. Use the configured DeepSeek executor on the fixed 10 MATH samples.

If code is faulty, modify the local project and retest. Retain actual results, changes, evidence, API calls, costs, failures, and retries. Do not start formal workflow search or present smoke-test scores as formal experiment results.

| Order | Node | Operation |
| --- | --- | --- |
| 1 | CONTEXT.LOAD | Load goals, repository boundaries, and work constraints. |
| 2 | MEMORY.RETRIEVE | Recover persisted preparation progress; TOOL still reads workspace files and logs. |
| 3 | CONTEXT.SELECT | Select historical information for current working context. |
| 4 | INFER.REASONING.TRAJECTORY | Identify entry points and code to inspect. |
| 5 | INTERACTION.ACT.TOOL | Read repository state through registered tools; MCP resources require an application adapter. |
| 6 | INTERACTION.OBSERVE | Receive code, paths, commit, configuration, and workflow state. |
| 7 | CONTEXT.UPDATE | Add code, version, and worktree state to current context. |
| 8 | INFER.REASONING.DELIBERATE | Analyze best-round selection and repeated validation results. |

Delivery and validation: application tools perform the edits and 10-sample run required by the task prose. DeepSeek is the configured executor, not a new Node Type. OUTPUT delivers actual results, patch, verification evidence, call/cost records, and the judgment on readiness for formal search. Retry and budget decisions belong to application execution policy.

## Evidence and Coverage Records

Associate formal coverage with case ID, original sample/task ID, code commit, actual Node Type, input/output references, tool/Provider implementation, and verification result. Repeated uses of a Node may have different Graph task IDs; deduplicate when counting type coverage. Record application entry, bind, connection startup, and test-side verifiers separately.

The supplied Agent Node Coverage Analysis report's 11/18 represents an earlier offline analysis of 12 samples against the pre-migration fixed baseline; its 7 uncovered Nodes were validation blind spots at that time. The figure is neither the six cases' run result nor convertible to coverage of the final 25 target Node Types. Final coverage requires new execution evidence keyed by the new fully qualified names.

Implementation state is based on dev commit a9e43212162650259b2a1bf9ed907d8bad19e79f's contracts, interaction loop, and MCP adapter; the target classification comes from the project-owner-approved final taxonomy. Case tasks come from the supplied Node Coverage and Agent Node Coverage Analysis documents. The source contained flow screenshots rather than a complete spreadsheet attachment, so the visible row counts remain unchanged.
