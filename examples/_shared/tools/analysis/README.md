# Analysis application tools

[简体中文](README.zh-CN.md) · [Seven examples](../../../capabilities/analysis/README.md)

This directory owns application materials, decoding, evidence and analysis rules without adding Core dependencies or private nodes.

- `domain.ts`: request/schema validation, units, deduplication, conflicts, reference checks, comparisons and serialization.
- `adapters.ts`: snapshots, text/HTTP reading, normalization, an external SQLite Provider and local report tools.

Reuse [file-ingestion](../file-ingestion/README.md) RegisteredTools for PDF, CSV/XLSX and image OCR, and [retrieval/web.ts](../retrieval/web.ts) for bounded HTTP/LinkeDOM parsing. [retrieval/memory.ts](../retrieval/memory.ts) explicitly ingests internal knowledge through the Memory Worker; analysis graphs read it through `MEMORY.SEARCH`. [storage](../storage/README.md) initializes Redis Context and database Memory.

`AnalysisAdapters(directory, request, python)` exposes `tools`, `providers`, and `close()`. The external database uses `documents(id, tenant, body)` and queries only an approved document ID plus bound tenant. Internal Memory validates key, kind and tenant. A trusted application configures sources, authority, periods and page origins; the model cannot change them.

Register `analysis_read`, `analysis_normalize`, `analysis_report`, `analysis_publish` and reused `decode_pdf`, `read_spreadsheet`, `ocr_image` through `createInteractionWorker({ tools })`; register the external Provider through `createRetrievalWorker({ providers })`. Execute through Runtime and close the adapter afterward.

HTTP uses approved origins, no redirects, a 20-second deadline and a 4 MiB response cap. Production URLs use HTTPS; explicitly configured loopback HTTP supports the fixture publisher. Local inputs must be regular files up to 4 MiB. Normalized sources allow at most 30 blocks of at most 1200 characters each. Only trusted controllers should modify sources, Memory and task directories.
