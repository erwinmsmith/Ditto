import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const childEnv = () =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG"].flatMap((k) =>
      process.env[k] ? [[k, process.env[k]!]] : [],
    ),
  );
/** The harness is trusted application code; untrusted programs arrive only via stdin. */
export async function isolatedNode(
  harness: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const name = `ditto-code-${randomUUID()}`,
    image = process.env.DITTO_EXAMPLE_CODE_IMAGE ?? "node:24-bookworm-slim";
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    "-i",
    image,
    "node",
    "--input-type=module",
    "-e",
    harness,
  ];
  signal?.throwIfAborted();
  try {
    return await new Promise<{ output: unknown; exitCode: number }>(
      (resolve, reject) => {
        const child = spawn("docker", args, {
          env: childEnv(),
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          failure: Error | undefined;
        const stop = (message: string) => {
          failure ??= new Error(message);
          child.kill("SIGKILL");
        };
        const cancel = () => stop("Code execution cancelled"),
          timer = setTimeout(() => stop("Code execution timed out"), 12000);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout.on("data", (c) => {
          stdout += String(c);
          if (Buffer.byteLength(stdout) > 65536)
            stop("Code output exceeded limit");
        });
        child.stderr.on("data", (c) => {
          stderr += String(c);
          if (Buffer.byteLength(stderr) > 65536)
            stop("Code error output exceeded limit");
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(e);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          if (failure || code !== 0) {
            reject(failure ?? new Error(`Isolated code exited ${code}`));
            return;
          }
          try {
            resolve({ output: JSON.parse(stdout), exitCode: code });
          } catch {
            reject(new Error("Code did not return JSON"));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(input));
      },
    );
  } finally {
    await exec("docker", ["rm", "-f", name], {
      env: childEnv(),
      timeout: 5000,
    }).catch(() => {});
  }
}
export function isolatedCode(
  code: string,
  input: unknown,
  signal?: AbortSignal,
) {
  return isolatedNode(
    `let text='';for await(const c of process.stdin)text+=c;const request=JSON.parse(text);const value=await new Function('input','"use strict";'+request.code)(Object.freeze(request.input));process.stdout.write(JSON.stringify(value));`,
    { code, input },
    signal,
  );
}
/** Run actual Node test files in the disposable container; no host mounts or credentials. */
export async function isolatedTests(
  files: Record<string, string>,
  signal?: AbortSignal,
) {
  const result = await isolatedNode(
    `import{mkdir,writeFile}from'node:fs/promises';import{spawnSync}from'node:child_process';let text='';for await(const c of process.stdin)text+=c;const files=JSON.parse(text);await mkdir('/tmp/task');for(const[name,content]of Object.entries(files)){if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw Error('Invalid filename');await writeFile('/tmp/task/'+name,content);}const r=spawnSync(process.execPath,['--permission','--allow-fs-read=/tmp/task','--test-isolation=none','--test','--test-reporter=tap','invoice.test.mjs'],{cwd:'/tmp/task',encoding:'utf8',timeout:7000,maxBuffer:24000,env:{PATH:'/usr/local/bin:/usr/bin:/bin'}});process.stdout.write(JSON.stringify({exitCode:r.status??124,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null}));`,
    files,
    signal,
  );
  return result.output as {
    exitCode: number;
    stdout: string;
    stderr: string;
    error: string | null;
  };
}
