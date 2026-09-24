import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'.vitepress/dist');
const repo=process.env.GITHUB_REPOSITORY || 'erwinmsmith/Ditto';
const name=repo.split('/')[1];
const base=process.env.DOCS_BASE || (name.endsWith('.github.io') ? '/' : `/${name}/`);
async function walk(dir){const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]))).flat();}
const files=await walk(root), pages=files.filter(f=>f.endsWith('.html'));
const failures=[];
const content=new Map(await Promise.all(pages.map(async p=>[p,await readFile(p,'utf8')])));
for(const page of pages){
 const html=await readFile(page,'utf8');
 for(const match of html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)){
  let href=match[1];if(/^(?:https?:|mailto:|tel:|data:|javascript:)/.test(href))continue;
  href=href.split('#')[0].split('?')[0];if(!href)continue;
  try{href=decodeURIComponent(href);}catch{continue;}
  let file=href.startsWith(base)?join(root,href.slice(base.length)):href.startsWith('/')?join(root,href):resolve(dirname(page),href);
  const info=await stat(file).catch(()=>undefined);
  if(info?.isDirectory())file=join(file,'index.html');
  if(!await stat(file).catch(()=>undefined))failures.push({page:page.slice(root.length),href});
 }
}
if(failures.length){console.error(failures.slice(0,40));throw new Error(`${failures.length} broken generated links`);}
for(const [page,html] of content) for(const match of html.matchAll(/href="([^"\s]*#[^"\s]+)"/g)) {
 const [path,fragment]=match[1].split('#'); if(!fragment || /^(?:https?:|mailto:)/.test(path)) continue;
 let target=path.startsWith(base)?join(root,path.slice(base.length)):path?resolve(dirname(page),path):page;
 if(path.endsWith('/'))target=join(target,'index.html');
 const destination=content.get(target); if(!destination)continue;
 if(!destination.includes('id="'+decodeURIComponent(fragment)+'"'))failures.push({page:page.slice(root.length),href:match[1]});
}
if(failures.length){console.error(failures.slice(0,40));throw new Error(`${failures.length} broken section links`);}
console.log(`Verified ${pages.length} HTML pages, local links, section anchors, assets and downloads.`);
