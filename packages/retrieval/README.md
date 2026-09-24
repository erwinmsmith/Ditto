# Ditto Retrieval

`@codesoul-co/ditto-retrieval` is the optional retrieval Worker for [`@codesoul-co/ditto`](https://github.com/erwinmsmith/Ditto). Install both packages when an application needs `RETRIEVAL.SEARCH` or its Memory and Context adapters.

```sh
npm install @codesoul-co/ditto @codesoul-co/ditto-retrieval
```

```ts
import { createRetrievalWorker, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";
import { createRetrievalContextStrategy } from "@codesoul-co/ditto-retrieval/adapters/context";
```

Register the Worker explicitly with Ditto's Runtime. Search providers, target registration, and database connections remain application controlled. See the [retrieval API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/retrieval.md) for configuration and examples.
