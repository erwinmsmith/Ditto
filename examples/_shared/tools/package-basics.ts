import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutputSink } from "@codesoul-co/ditto/worker/interaction";

/** Application-owned output adapter. The trusted host chooses the destination. */
export function answerFiles(directory: string): OutputSink {
  return { async deliver(input) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.deliveryId) || typeof input.message.content !== "string") {
      throw new Error("A bounded delivery ID and text answer are required");
    }
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${input.deliveryId}.md`), input.message.content + "\n", "utf8");
    return { deliveryId: input.deliveryId, status: "accepted" };
  } };
}
