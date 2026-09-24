import { RetrievalError, type RetrievalCandidate } from "../types.js";
import type { RetrievalSearchInput } from "../search/types.js";
import type { RetrievalSearchProvider } from "../registry/providers.js";
import type { RetrievalExecutionContext } from "../search/providers/types.js";
import { validateVector } from "../search/providers/embedding.js";
import { normalizeOutput, validateSearch } from "../search/schema.js";

export interface SqlSearchStatement { readonly text: string; readonly values: readonly unknown[]; }
export interface SqlSearchOptions<Row> {
  /** Owns dialect, identifiers, namespace authorization, filters and ORDER BY/LIMIT. Bind all caller values. */
  readonly prepare: (input: RetrievalSearchInput) => SqlSearchStatement;
  /** Adapt pg's result.rows or mysql2's tuple here. Reuse the storage plugin's connection pool. */
  readonly query: (statement: SqlSearchStatement, context: RetrievalExecutionContext) => Promise<readonly Row[]>;
  readonly mapRow: (row: Row) => RetrievalCandidate;
}
export function createSqlSearchProvider<Row>(options: SqlSearchOptions<Row>): RetrievalSearchProvider {
  return { async search(input, context = {}) {
    const request = { ...input, limit: input.limit ?? context.defaults?.searchLimit ?? 10 };
    validateSearch(request);
    context.signal?.throwIfAborted();
    const statement = options.prepare(request);
    if (!statement.text.trim() || !Array.isArray(statement.values)) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Invalid SQL search statement");
    const rows = await options.query(statement, context);
    context.signal?.throwIfAborted();
    return normalizeOutput({ target: request.target, strategy: request.strategy, candidates: rows.map(options.mapRow) }, request);
  } };
}

export interface MilvusSearchScope {
  readonly filter?: string;
  readonly exprValues?: Record<string, unknown>;
  readonly partition_names?: string[];
}
export interface MilvusSearchRequest extends MilvusSearchScope {
  collection_name: string;
  anns_field: string;
  data: number[][] | string[];
  limit: number;
  output_fields: string[];
  params?: Record<string, unknown>;
}
export interface MilvusSearchResponse<Hit> {
  status: { code?: number; error_code?: string; reason?: string };
  results: readonly Hit[];
}
export interface MilvusSearchOptions<Hit> {
  readonly collection: string;
  readonly vectorField: string;
  readonly outputFields: readonly string[];
  readonly search: (request: MilvusSearchRequest, context: RetrievalExecutionContext) => Promise<MilvusSearchResponse<Hit>>;
  readonly mapHit: (hit: Hit) => RetrievalCandidate;
  /** Must enforce namespace/filter semantics. Return parameterized database expressions. */
  readonly scope?: (input: RetrievalSearchInput) => MilvusSearchScope;
  readonly params?: Record<string, unknown>;
}
/** Inject the existing Milvus client's search method. No client, database or index lifecycle is owned here. */
export function createMilvusSearchProvider<Hit>(options: MilvusSearchOptions<Hit>): RetrievalSearchProvider {
  if (!options.collection.trim() || !options.vectorField.trim()) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Missing Milvus collection or field");
  const outputFields = [...options.outputFields];
  const params = options.params === undefined ? undefined : structuredClone(options.params);
  return { async search(input, context = {}) {
    const request = { ...input, limit: input.limit ?? context.defaults?.searchLimit ?? 10 };
    validateSearch(request);
    context.signal?.throwIfAborted();
    if ((input.target.namespace !== undefined || input.filter !== undefined) && !options.scope) {
      throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Milvus namespace/filter requires an explicit scope mapper");
    }
    const content = input.query.content;
    let data: number[][] | string[];
    if (typeof content === "string" && content.trim()) data = [content];
    else { validateVector(content); data = [[...content]]; }
    const scope = options.scope?.(request) ?? {};
    const response = await options.search({
      ...scope, collection_name: options.collection, anns_field: options.vectorField,
      data, limit: request.limit, output_fields: [...outputFields],
      ...(params === undefined ? {} : { params: structuredClone(params) }),
    }, context);
    context.signal?.throwIfAborted();
    const status = response?.status;
    if (!status || (status.code === undefined && status.error_code === undefined)
      || (status.code !== undefined && status.code !== 0)
      || (status.error_code !== undefined && status.error_code !== "Success")) {
      throw new RetrievalError("RETRIEVAL_BACKEND_ERROR", "Milvus search failed");
    }
    if (!Array.isArray(response.results)) throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Invalid Milvus result list");
    return normalizeOutput({ target: request.target, strategy: request.strategy, candidates: response.results.map(options.mapHit) }, request);
  } };
}
