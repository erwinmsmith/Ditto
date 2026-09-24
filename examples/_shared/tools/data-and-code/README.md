# Data and code tools

[简体中文](README.zh-CN.md) · [Twelve workflows](../../../capabilities/data-and-code/README.md)

`dataCodeTools(directory, request, {python})` provides application-owned `RegisteredTool[]` for `createInteractionWorker`. Scripts, business policies, tests and chart templates stay outside Core dependencies/configuration.

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
uv venv examples/_shared/tools/.venv
uv pip install --python examples/_shared/tools/.venv/bin/python \
  -r examples/_shared/tools/data-and-code/requirements.txt
brew install ripgrep
# Start Docker and preload the execution image.
docker pull node:24-bookworm-slim
export DITTO_EXAMPLE_DATA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
```

Use the platform package manager for ripgrep on other systems. CSV/SQLite use Python's standard library; Matplotlib only renders charts. Deployers may set `DITTO_EXAMPLE_CODE_IMAGE` to a preloaded Node.js 24+ image, preferably a digest-pinned image for deployment. The executor never pulls implicitly. Parser/container processes do not inherit model credentials.

The tool catalog covers source snapshots, authorized SQL, generated cleaning/calculation programs, statistical profiles, chart rendering, metrics, literal repository search, protected code edits/tests and report delivery. Each task registers only its own operation plus source/publication tools. Effect declarations do not replace controller authorization.

SQL is confined to six columns of the sales snapshot. Connections use read-only immutable mode, query-only policy, a SQLite authorizer, disabled extension loading and a VM instruction/time budget. Writes, attachments, unauthorized tables/columns/functions, multiple statements and over 100 returned rows fail. Values use bound parameters. See [Python SQLite](https://docs.python.org/3/library/sqlite3.html).

Inputs are bounded to 256000 bytes per file, 256 CSV rows and 48000 UTF-8 bytes of combined Context material. A trusted application owns task/output directories; the directory scheme is not an OS permission sandbox for hostile local users.

The [shared Docker executor](../execution/docker.ts) reuses the operations examples' isolation: non-root, no network, no host mounts, read-only root, dropped capabilities, no privilege escalation, 128 MiB RAM, 1 CPU, 32 processes, 16 MiB temporary storage, 64 KiB output and a 12-second limit. Cancellation/failure removes the container; there is no host eval fallback.

`isolatedCode` executes a function body inside Docker. `isolatedTests` writes supplied source/tests inside its disposable filesystem and runs actual `node --test`. The test process uses the [Node Permission Model](https://nodejs.org/download/release/v24.7.0/docs/api/permissions.html) with read-only test-directory access and no write/child-process/Worker grant. Docker is the primary isolation boundary. Passing tests does not authorize deployment.

Only invoice.mjs may be replaced; original tests/inputs remain pinned. Actual TAP logs and structured summaries are retained. Models cite short values from an enumerated evidence catalog, not regenerated log blobs. Completed tool receipts support recovery after tool completion; disk errors/conflicting partial outputs fail explicitly.

The renderer adapts the data-viz skill's Figure 07 and grouped_bars implementation, preserving canvas, axes, layout and palette. Region/status totals replace biological example data. Unsupported sample dots, uncertainty, significance and biological labels are removed. No reference-template observations enter the result. `chart-data.json` records actual totals; Agg produces PNG plus editable SVG text/vector elements.
