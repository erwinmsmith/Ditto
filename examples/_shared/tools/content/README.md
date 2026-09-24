# Content tools, validation and rendering

[简体中文](README.zh-CN.md) · [Application tools](../README.md) · [Seven workflows](../../../capabilities/content/README.md)

Application-owned content rules, source reading and publication using Node.js standard libraries. No vendor SDK or Core dependency is added. Public Worker factories register the model, Redis and SQLite Memory; see [storage setup](../storage/README.md).

| File | Responsibility |
| --- | --- |
| [domain.ts](domain.ts) | Requests, source descriptors, evidence blocks, requirements, draft/review validation |
| [fixtures.ts](fixtures.ts) | Dedicated task materials, immutable input manifest and task reopening |
| [tools.ts](tools.ts) | `content_sources` / `content_publish` tools and file lifecycle |
| [render.ts](render.ts) | JSON, Markdown, HTML, source copies and hash manifests from the same draft |

Inject `contentTools(directory, request)` into `createInteractionWorker({ tools })` and execute via Runtime Graph. Importing modules does not read files, open connections, call models or publish output.

`content_sources` reads only controller-selected `brief.md`, `notes.md` and `draft.md`, each at most 16 KiB. It validates regular files, SHA-256 and line-based blocks; Markdown titles are excluded from evidence blocks. This is a UTF-8 source protocol, not a PDF/Word or general Markdown AST parser.

`content_publish` revalidates snapshots, draft and approved review, renders fixed filenames, writes each file and reads it back. Identical writes permit recovery; conflicts fail. Partial files can remain after a failed publication; the complete manifest is written last.

HTML titles, prose and quoted sources are escaped; no scripts are emitted. Markdown special characters are escaped. Reference destinations derive from validated filenames/lines rather than arbitrary model URLs. Output and source subdirectories reject symlinks.

Exact quotes and required source coverage are deterministic checks. A separate model review checks semantic support, translation/negation fidelity and style transformation. Rejection blocks publication and is never silently converted to approval. Changed draft requirements should use a new task or an explicit application editing/revision flow.

Keep each task in a dedicated directory. Inputs, SQLite, model outputs, review files, HTML and acceptance reports are application data excluded by repository ignore rules. Do not commit real user materials or credentials.

For expansion, the application preserves the original lead verbatim from the committed snapshot. The model generates only additional sections; the assembled draft is validated and reviewed as a whole.
