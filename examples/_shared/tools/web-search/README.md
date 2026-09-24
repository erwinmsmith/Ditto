# Web search application tools

[简体中文](README.zh-CN.md)

These adapters are application dependencies, separate from `@codesoul-co/ditto`. `providers.ts` supplies a public `WebSearchProvider`; `http.ts` handles bounded reading; `adapters.ts` registers authorization, page reading, snapshot checking and publication tools. `domain.ts` defines the application request/report contracts. Citation and grounding validators are shared with RAG in `../evidence.ts`.

Install `redis` and `linkedom` using the versions in the existing storage/retrieval dependency manifests. No extra package is added to Core.

| Setting | Meaning |
| --- | --- |
| `DITTO_WORKER_CONTEXT_REDIS_URL` | Required Redis Context connection |
| `DITTO_EXAMPLE_WEB_SEARCH_ENGINE` | `mediawiki` (demo default) or `brave` (general web search) |
| `DITTO_EXAMPLE_WEB_SEARCH_ENDPOINT` | MediaWiki API URL; default `https://en.wikipedia.org/w/api.php` |
| `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY` | Brave credential when selected; never saved in task artifacts |
| `DITTO_EXAMPLE_WEB_TRUST_BENCHMARK_PROXY=1` | Explicit host-only opt-in for trusted local VPN/proxy fake DNS in 198.18.0.0/15; leaves other private ranges blocked |

MediaWiki searches that wiki's indexed content, not the entire Internet. Select Brave or inject another public WebSearchProvider for general web coverage. The built-in Brave adapter enforces its own public Core provider limits. MediaWiki and page reads use this application's bounded transport. No automatic provider switch or offline search substitute is configured.

Production reads require HTTPS and explicit allowed origins. DNS results must be public and the connection is pinned to the checked address while retaining TLS hostname verification. Credential-bearing URLs and literal IPs are rejected. Redirects are revalidated, with at most three redirects. HTML/JSON responses are bounded to 1 MiB, one attempt has a 20-second deadline, and 429/502/503/504 responses allow two retries. Retry-After seconds/date is honored up to 60 seconds per wait; longer delays fail for the caller to reschedule. The enclosing task signal aborts requests and retry waits. This adapter does not bypass authentication, CAPTCHAs or site restrictions.

`allowLoopbackTest` exists solely as an explicit adapter-constructor setting for the controlled HTTP test server; it cannot come from an Agent request or a model response. The CLI never enables it. The benchmark-proxy flag is likewise host configuration, not a user network permission.

The HTML decoder removes scripts/navigation/forms and extracts readable paragraphs; no page scripts run. JavaScript-rendered pages, PDFs, audio, paywalls and login flows are outside this tool. Empty/non-HTML pages fail reading. The normalized body is limited to 120 paragraph chunks and 100000 characters; at most four ranked chunks per page enter screening. Paragraph locations describe the normalized snapshot, not original HTML line numbers. Retrieval timestamps are not publication dates, and snapshots do not guarantee current truth after the fetch.

`request.json` and `policy.json` are created by the trusted host. Revoking `policy.enabled` or removing the principal prevents further work and publication, including replay. Keep task directories and policy files writable only by the host. Search/page snapshots and output files use immutable writes; a partial publication retries against identical stored content. Artifacts can contain source content and should follow the host's retention rules.
