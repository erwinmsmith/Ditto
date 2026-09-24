import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDitto, graph, createInteractionWorker } from '@codesoul-co/ditto';

/** dependencies is an application directory with the official SDK and filesystem server installed. */
export async function runMcp(workspace, filename, dependencies = process.cwd()) {
  const requireSdk = createRequire(resolve(dependencies, 'package.json'));
  const { Client } = requireSdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = requireSdk('@modelcontextprotocol/sdk/client/stdio.js');
  const server = requireSdk.resolve('@modelcontextprotocol/server-filesystem/dist/index.js');
  const client = new Client({ name: 'ditto-handbook', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, resolve(workspace)], stderr: 'inherit' });
  let runtime;
  try {
    await client.connect(transport);
    const adapter = {
      listTools: (params, options) => client.listTools(params, options),
      async callTool(params, options) {
        const result = await client.callTool(params, undefined, options);
        return { content: result.content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          ...(result.isError === undefined ? {} : { isError: result.isError }) };
      },
    };
    runtime = createDitto({ sandbox: { mcp: ['files'] },
      workers: [createInteractionWorker({ mcp: { files: adapter } })] });
    const plan = graph('read-via-mcp')
      .node('discovery', 'INTERACTION.ACT.MCP', [], () => ({ operation: 'discover', server: 'files' }))
      .node('read', 'INTERACTION.ACT.MCP', ['discovery'], (path, { discovery }) => {
        if (discovery.operation !== 'discover' || !discovery.capabilities.some(tool => tool.name === 'read_text_file')) throw new Error('Required MCP tool missing');
        return { operation: 'invoke', server: 'files', call: { id: 'read-1', name: 'read_text_file', arguments: { path } } };
      })
      .node('observation', 'INTERACTION.OBSERVE', ['read'], (_input, { read }) => {
        if (read.operation !== 'invoke') throw new Error('Expected invocation');
        return { result: read.result };
      });
    const output = await runtime.run(plan, resolve(workspace, filename), { signal: AbortSignal.timeout(15_000) });
    if (output.observation.status !== 'success') throw new Error(output.observation.error?.message ?? 'MCP read failed');
    return output.observation;
  } finally {
    try { await runtime?.close(); } finally { try { await client.close(); } finally { await transport.close(); } }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node mcp.mjs WORKSPACE RELATIVE_FILE [DEPENDENCY_DIRECTORY]');
  console.log(JSON.stringify(await runMcp(process.argv[2], process.argv[3], process.argv[4]), null, 2));
}
