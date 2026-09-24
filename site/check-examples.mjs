/** Install the downloadable examples as a consumer, with no repository source aliases. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(join(tmpdir(),'ditto-docs-consumer-'));
const exec=promisify(execFile);
const env={...process.env};delete env.NODE_PATH;delete env.NODE_OPTIONS;
async function run(command,args){try{return (await exec(command,args,{cwd:temp,env,timeout:180000,maxBuffer:4*1024*1024})).stdout;}catch(e){console.error(e.stderr);throw e;}}
try {
 const archive=join(root,'site/.content/public/downloads/ditto-examples.zip');
 const entries=(await run('unzip',['-Z1',archive])).split('\n');
 assert.ok(entries.every(p=>!/(?:^|\/)(?:AGENTS\.md|agents\.md|node_modules|\.env$|src\/)/.test(p)&&!p.includes('live-results')&&!p.endsWith('.sqlite')));
 await run('unzip',['-q',archive]);
 await run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
 const json=async file=>JSON.parse(await run(process.execPath,[file]));
 const context=await json('examples/package-basics/context.ts');assert.equal(context.context.items[0].content,'Hello Ditto');
 const extension=await json('examples/handbook/extensions.ts');assert.equal(extension.analysis.text,'Hello Ditto');assert.equal(extension.analysis.calls,1);
 const skills=await json('examples/handbook/skills.ts');assert.ok(skills.selected.context.items.some(item=>item.id==='skill:review'&&item.content.includes('verified facts')));
 const ranking=await json('examples/handbook/memory-ranking.ts');assert.equal(ranking.found.status,'success');assert.equal(ranking.found.output[0].memory.key,'handbook:newer');
 const replay=await json('examples/handbook/memory-ranking.ts');assert.equal(replay.found.output[0].memory.id,ranking.found.output[0].memory.id);
 const compilerOptions={target:'ES2024',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,verbatimModuleSyntax:true,noEmit:true,types:['node'],allowImportingTsExtensions:true};
 await writeFile(join(temp,'tsconfig.json'),JSON.stringify({compilerOptions,include:['examples/handbook/**/*.ts','examples/package-basics/**/*.ts']}));
 await run(join(temp,'node_modules/.bin/tsc'),['-p','tsconfig.json']);
 // Same definition registered twice has independent resources; its private Node cannot be routed externally.
 await run(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {createDitto} from '@codesoul-co/ditto';import {textWorker} from './examples/handbook/extensions.ts';const runtime=createDitto();runtime.register(textWorker(),'a');runtime.register(textWorker(),'b');try {for(const workerId of ['a','b'])assert.equal((await runtime.invoke('EXAMPLE.HANDBOOK.TEXT.ANALYZE',{text:' hi '},{workerId})).calls,1);await assert.rejects(runtime.invoke('EXAMPLE.HANDBOOK.TEXT.NORMALIZE',{text:'hi'}));}finally{await runtime.close();}`]);
 // Execute the complete Graph/Loop block exactly as documented.
 const guide=await readFile(join(root,'docs/handbook/graph-loop.md'),'utf8');const code=/```js\n([\s\S]*?)\n```/.exec(guide)?.[1];assert.ok(code);
 await writeFile(join(temp,'loop.mjs'),code);assert.ok((await run(process.execPath,['loop.mjs'])).includes('Hello Ditto'));
 await run('npm',['install','--ignore-scripts','--no-audit','--no-fund','@modelcontextprotocol/sdk@1.30.0','@modelcontextprotocol/server-filesystem@2026.8.31']);
 await mkdir(join(temp,'workspace'));await writeFile(join(temp,'workspace/hello.txt'),'Hello from MCP\n');
 const mcp=JSON.parse(await run(process.execPath,['examples/handbook/mcp.mjs','workspace','hello.txt','.']));assert.equal(mcp.status,'success');assert.ok(JSON.stringify(mcp.message).includes('Hello from MCP'));
 if(process.argv.includes('--live')){
  const first=JSON.parse(await run(process.execPath,['examples/package-basics/agent.ts','--session','docs-test','--turn','one','--prompt','Remember my project code orchid-docs-72. Repeat it exactly.']));assert.ok(first.answer.includes('orchid-docs-72'));
  const second=JSON.parse(await run(process.execPath,['examples/package-basics/agent.ts','--session','docs-test','--turn','two','--prompt','What is my project code? Reply with the code only.']));assert.ok(second.answer.includes('orchid-docs-72'));assert.equal((await readFile(second.file,'utf8')).trim(),second.answer.trim());
  console.log('Downloaded consumer Agent: real model, Redis, SQLite, process recovery and answer file passed.');
 }
 console.log('Downloaded examples: npm imports, strict types, Worker isolation, Skill, SQLite ranking/replay, documented Loop and real MCP passed.');
} finally {await rm(temp,{recursive:true,force:true});}
