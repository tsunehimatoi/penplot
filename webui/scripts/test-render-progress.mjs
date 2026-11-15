// Integration: scheduler -> API -> streamed pages -> visible progress/cancel/retry UI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const webRoot = fileURLToPath(new URL('..', import.meta.url))
import { createServer } from 'vite'
import { chromium } from 'playwright'
const directory=path.resolve(process.argv[2]??path.join(webRoot,'../build/letter-stream-md'))
const meta=JSON.parse(fs.readFileSync(path.join(directory,'meta.json'),'utf8'))
const count=Math.min(meta.pages,12), buffers=Array.from({length:count},(_,i)=>fs.readFileSync(path.join(directory,`${i}.bin`)))
let requests=0
const html=`<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'
import {createRoot} from 'react-dom/client'
import {RenderProgress} from '/src/features/studio/render-progress.tsx'
import {requestElements,useRender} from '/src/features/studio/render-engine.ts'
import {lastKeys} from '/src/features/studio/actions.ts'
import {emptyDoc,makeFlow} from '/src/features/studio/model.ts'
import {useStudio} from '/src/features/studio/store.ts'
const doc=emptyDoc('test'), el=makeFlow(null,'test')
doc.pages[0].elements=[el];lastKeys.set(el.id,'integration');useStudio.setState({doc})
const items=[{key:'integration',el,paper:doc.paper}]
createRoot(document.getElementById('root')).render(React.createElement(RenderProgress))
window.state=()=>useRender.getState().els.integration
window.start=()=>requestElements('test',items,{})
window.requestOldCancelled=()=>{useRender.getState().set('integration',{...window.state(),at:Date.now()-20000});window.start()}
window.ready=true
</script></body></html>`
const server=await createServer({root:webRoot,server:{host:'127.0.0.1',port:0},plugins:[{
 name:'render-progress-fixture', configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 const url=req.url.split('?')[0]
 if(url==='/integration'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(url,html));return}
 if(url==='/api/v1/projects/test/preview'){
  requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({rid:'integration',preview_only:true,pages:buffers.map((_,index)=>({index,source_page:0,warnings:{}}))}));return
 }
 if(url==='/api/v1/render/integration/paths-stream'){
  res.setHeader('Content-Type','application/octet-stream');let i=0,timer
  const write=()=>{if(i===count){res.end();return}const b=buffers[i],h=Buffer.alloc(8);h.writeUInt32LE(i++,0);h.writeUInt32LE(b.length,4);res.write(Buffer.concat([h,b]));timer=setTimeout(write,60)}
  res.on('close',()=>clearTimeout(timer));write();return
 }
 next()
 })}
}]})
let browser
try{
 await server.listen();browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL??'chrome'})
 const page=await browser.newPage();page.on('pageerror',e=>{throw e})
 await page.goto(`${server.resolvedUrls.local[0]}integration`);await page.waitForFunction(()=>window.ready)
 await page.evaluate(()=>window.start())
 await page.waitForFunction(()=>window.state()?.completedPages>0&&window.state()?.status==='pending')
 assert.ok((await page.getByRole('status').innerText()).includes('预览已就绪'))
 await page.getByRole('button',{name:'取消预览',exact:true}).click()
 await page.waitForFunction(()=>window.state()?.code==='cancelled')
 const cancelled=await page.evaluate(()=>({status:window.state().status,total:window.state().pages.length,ready:window.state().completedPages,drawn:window.state().pages.filter(p=>p.d).length}))
 assert.equal(cancelled.status,'error');assert.equal(cancelled.total,count);assert.ok(cancelled.drawn>0&&cancelled.drawn<count)
 await page.evaluate(()=>window.requestOldCancelled())
 assert.equal(await page.evaluate(()=>window.state().code),'cancelled')
 await page.getByRole('button',{name:'重试预览',exact:true}).click()
 await page.waitForFunction(()=>window.state()?.status==='ok')
 assert.equal(await page.evaluate(()=>window.state().completedPages),count)
 assert.equal(requests,2,'manual retry is the only new request after cancellation')
 console.log(JSON.stringify({cancelled,retryPages:count,requests,progressUI:true}))
}finally{await browser?.close();await server.close()}
