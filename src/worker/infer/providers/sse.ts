import { abortable, InferError } from "../validation.js";
/** Decode SSE data frames across arbitrary UTF-8 and CRLF chunk boundaries. */
export async function* readSse(response: Response, signal: AbortSignal): AsyncIterable<string> {
  if (!response.body) throw new InferError("INVALID_MODEL_OUTPUT", "Provider returned no stream");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  const data = (frame: string) => frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal);
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        if (boundary > 1024 * 1024) throw new InferError("INVALID_MODEL_OUTPUT", "Provider SSE frame exceeds 1 MiB");
        const value = data(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
        if (value) yield value;
      }
      if (buffer.length > 1024 * 1024) throw new InferError("INVALID_MODEL_OUTPUT", "Provider SSE frame exceeds 1 MiB");
      if (chunk.done) { const value = data(buffer); if (value) yield value; break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
