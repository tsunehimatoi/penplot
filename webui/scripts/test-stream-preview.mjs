// Uses the same private PPL1 fixture for both b2673ef and the current implementation.
// PLAYWRIGHT_CHANNEL=chrome node scripts/test-stream-preview.mjs ../build/letter-perf
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const webRoot = fileURLToPath(new URL('..', import.meta.url))
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const directory = path.resolve(process.argv[2] ?? path.join(webRoot, '../build/letter-perf'))
const meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'))
const buffers = Array.from({length:meta.pages}, (_, i) => fs.readFileSync(path.join(directory, `${i}.bin`)))
const baseline = execFileSync('git', ['show', 'b2673ef:webui/src/features/studio/path-conversion.ts'], {encoding:'utf8', cwd:webRoot})
const baselinePath = path.join(webRoot, 'src/features/studio/path-conversion-baseline.ts')
const html = `<!doctype html><html><body><script type="module">
import {fetchPathPreview as oldFetch} from '/src/features/studio/path-conversion-baseline.ts'
import {streamPathPreviews} from '/src/features/studio/path-conversion.ts'
import {buildPathPreview} from '/src/features/studio/path-data.ts'
window.run = async optimized => {
  const start = performance.now(), pages = [], events = []
  if (optimized) await streamPathPreviews('test', Array.from({length:${meta.pages}},(_,i)=>i), (i,p) => {
    pages[i]=p; events.push({index:i,ms:performance.now()-start})
  })
  else {
    const result = await Promise.all(Array.from({length:${meta.pages}}, (_,i)=>oldFetch('test',i)))
    pages.push(...result); events.push({index:0,ms:performance.now()-start})
  }
  window.pages=pages
  return {totalMs:performance.now()-start,firstVisibleMs:events[0].ms,updates:events.length}
}
window.check = async () => {
 const valid = await Promise.all(window.pages.map(async(p,i) => JSON.stringify(p) === JSON.stringify(buildPathPreview(await (await fetch('/fixture/'+i)).arrayBuffer()))))
 const ctl = new AbortController(); let count=0, cancelled=false, truncated=false
 try { await streamPathPreviews('test', Array.from({length:${meta.pages}},(_,i)=>i), () => {count++;ctl.abort()}, ctl.signal) } catch(e) {cancelled=e.name==='AbortError'}
 const countAtCancel=count
 await new Promise(requestAnimationFrame)
 try {await streamPathPreviews('truncated', [0,1],()=>{})} catch(e) {truncated=e.message.includes('不完整')}
 return {valid:valid.every(Boolean),cancelled,noLatePages:count===countAtCancel,truncated}
}
window.ready=true
</script></body></html>`
const server = await createServer({root:webRoot,server:{host:'127.0.0.1',port:0},plugins:[{
 name:'stream-test', resolveId(id) { if(id==='/src/features/studio/path-conversion-baseline.ts') return baselinePath.replaceAll('\\','/') }, load(id) {if(id===baselinePath.replaceAll('\\','/')) return baseline},
 configureServer(vite) {vite.middlewares.use(async(req,res,next)=>{
  const url=req.url.split('?')[0]
  if(url==='/stream-test'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(url,html));return}
  const match=/^\/api\/v1\/render\/(test|truncated)\/paths-stream$/.exec(url)
  if(match){res.setHeader('Content-Type','application/octet-stream');for(let i=0;i<(match[1]==='truncated'?1:buffers.length);i++){
   const h=Buffer.alloc(8);h.writeUInt32LE(i,0);h.writeUInt32LE(buffers[i].length,4)
   // Fragment headers and bodies to exercise arbitrary network boundaries.
   res.write(h.subarray(0,3));res.write(h.subarray(3));res.write(buffers[i])
  }res.end();return}
  const m=/^\/api\/v1\/render\/test\/pages\/(\d+)\/paths$/.exec(url)??/^\/fixture\/(\d+)$/.exec(url)
  if(m){res.setHeader('Content-Type','application/octet-stream');res.end(buffers[Number(m[1])]);return}
  next()
 })}
}]})
let browser
try {
 await server.listen();browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'})
 const result={fixture:meta,runs:[]}
 for(let round=0;round<3;round++)for(const optimized of [false,true]){
  const page=await browser.newPage();page.on('pageerror',e=>{throw e})
  await page.goto(`${server.resolvedUrls.local[0]}stream-test`);await page.waitForFunction(()=>window.ready)
  const measurement=await page.evaluate(o=>window.run(o),optimized)
  if(optimized){const checks=await page.evaluate(()=>window.check());assert.deepEqual(checks,{valid:true,cancelled:true,noLatePages:true,truncated:true})}
  result.runs.push({round,mode:optimized?'stream-pool':'b2673ef-single-worker',...measurement});await page.close()
 }
 fs.writeFileSync(path.join(directory,'stream-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
} finally {await browser?.close();await server.close()}
