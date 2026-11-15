// Isolated browser regression: real PPL1 decoding and SVG strokes, no machine/backend.
// Run from webui: node scripts/test-print-preview.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '/src/components/ui/index.ts'
import { queryClient } from '/src/api/query.ts'
import { fetchPaths, decodePaths } from '/src/api/studio.ts'
import { PrintSheet } from '/src/features/studio/sheets/print-sheet.tsx'
import { useStudio } from '/src/features/studio/store.ts'
import { emptyDoc, makeFlow, newPage, FALLBACK_PAPER, DEFAULT_ORIGIN } from '/src/features/studio/model.ts'
import '/src/index.css'
const h = React.createElement
const doc = emptyDoc('打印路径回归')
doc.print.origin = {...DEFAULT_ORIGIN, anchor:'content'}
doc.pages[0].elements = [makeFlow(null, '第一页\\n第二页\\n第三页', 'plain')]
doc.pages.push(newPage())
useStudio.setState({doc, project:{id:'print-test',name:'打印路径回归',rev:1}, placement:{dx:7,dy:9}, view:{page:0,sub:2}})
window.fixture = { useStudio, fetchPaths, decodePaths }
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,null,h(TooltipProvider,null,h(PrintSheet,{open:true,onOpenChange(){},paper:FALLBACK_PAPER,origin:DEFAULT_ORIGIN,onOpenPosition(){}})))))
</script></body></html>`
const server = await createServer({server:{host:'127.0.0.1',port:0,open:false,hmr:false},plugins:[{
  name:'print-test-fixture', configureServer(vite) {
    vite.middlewares.use('/print-test',async (_req,res) => {
      res.setHeader('Content-Type','text/html')
      res.end(await vite.transformIndexHtml('/print-test',html))
    })
  },
}]})
let browser
try {
  await server.listen()
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})})
  const page = await browser.newPage({viewport:{width:1200,height:850}})
  page.setDefaultTimeout(15000)
  const errors = [], requests = []
  let failPage = -1, renderNumber = 0
  page.on('pageerror',e => errors.push(e.message))
  await page.routeWebSocket('**/api/v1/ws',() => {})
  await page.route('**/api/v1/**',async route => {
    const url = new URL(route.request().url()), path = url.pathname
    if (path.endsWith('/paths')) {
      const index = Number(path.split('/').at(-2))
      requests.push({index,space:url.searchParams.get('space')})
      if (index === failPage) return route.fulfill({status:500,json:{detail:'test failure'}})
      const binary = Buffer.alloc(40)
      binary.writeUInt32LE(0x314c5050,0); binary.writeUInt32LE(1,4)
      binary.writeUInt32LE(0,8); binary.writeUInt32LE(3,12)
      ;[47,49+index*20,147,49+index*20,147,59+index*20].forEach((n,i) => binary.writeFloatLE(n,16+i*4))
      return route.fulfill({body:binary,contentType:'application/octet-stream'})
    }
    if (path.endsWith('/profiles')) return route.fulfill({json:[{id:'test',name:'Test',is_active:true,doc:{type:'Grbl',settings:{},axes:{},grbl:{type:'Servo'},advanced:{},work_area:{w_mm:0,h_mm:0}}}]})
    if (path.endsWith('/render')) {
      const body = route.request().postDataJSON()
      assert.equal(body.doc.pages[0].elements[0].transform.x,7)
      assert.equal(body.doc.pages[0].elements[0].transform.y,9)
      return route.fulfill({json:{rid:'print-'+(++renderNumber),pages:[0,1,2,3].map(index => ({index,source_page:index===3?1:0,bbox:[47,49+index*20,147,59+index*20],machine_bbox:[0,-10,100,0],est_s:10,out_of_work_area:false,stats:{strokes:1,draw_mm:110,travel_mm:0},warnings:{missing_glyphs:[],messages:[],clipped:false,overflow:false}}))}})
    }
    return route.fulfill({json:[]})
  })
  await page.goto(`${server.resolvedUrls.local[0]}print-test`)
  const dialog = page.getByRole('dialog',{name:'打印',exact:true})
  const svg = dialog.getByRole('img',{name:'纸张与行程预览'})
  async function visiblePath(index) {
    const path = svg.locator(`[data-print-paths="${index}"]`)
    await path.waitFor()
    const geometry = await path.evaluate(el => {
      const b = el.getBBox(), s = getComputedStyle(el), paper = getComputedStyle(el.parentNode.querySelector('rect'))
      const v = el.ownerSVGElement.viewBox.baseVal
      return {x:b.x,y:b.y,w:b.width,h:b.height,length:el.getTotalLength(),stroke:s.stroke,fill:paper.fill,strokeWidth:s.strokeWidth,inside:b.x>=v.x && b.y>=v.y && b.x+b.width<=v.x+v.width && b.y+b.height<=v.y+v.height}
    })
    assert.equal(geometry.x,47,'placement must be applied exactly once')
    assert.equal(geometry.y,49+index*20,'physical page paths must be distinct')
    assert.equal(geometry.length,110)
    assert.equal(geometry.inside,true)
    assert.notEqual(geometry.stroke,'none')
    assert.notEqual(geometry.stroke,geometry.fill,'ink must contrast with paper')
    assert.ok(parseFloat(geometry.strokeWidth)>0)
  }
  await visiblePath(0)
  assert.deepEqual(await page.evaluate(async () => {
    const lines = await fixture.fetchPaths('compatibility',2)
    return {decoder:typeof fixture.decodePaths,points:Array.from(lines[0])}
  }),{decoder:'function',points:[47,89,147,89,147,99]},'legacy studio imports still decode PPL1')
  if (process.env.PRINT_PREVIEW_SCREENSHOT) await svg.screenshot({path:process.env.PRINT_PREVIEW_SCREENSHOT})
  for (const index of [1,2,3]) {
    await dialog.getByRole('combobox',{name:'预览页'}).click()
    await page.getByRole('option',{name:`预览第 ${index+1} 页`,exact:true}).click()
    await visiblePath(index)
  }
  await dialog.getByRole('radio',{name:'当前页',exact:true}).click()
  await visiblePath(2)
  for (const corner of [0,1,2,3]) {
    await page.evaluate(corner => fixture.useStudio.getState().edit(d => {
      d.print.origin = {...d.print.origin,corner,revxy:true,x_rev:true,y_rev:true}
    }),corner)
    const expected = {x:corner===1||corner===3 ? 184.2 : 38.8, y:corner>=2 ? 279.6 : 34.4}
    const marker = svg.locator('circle').first()
    assert.ok(Math.abs(Number(await marker.getAttribute('cx'))-expected.x)<0.001)
    assert.ok(Math.abs(Number(await marker.getAttribute('cy'))-expected.y)<0.001)
    await page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/render'))
    await visiblePath(2)
  }
  // A failed page must expose a retry and must never show the previous page's ink.
  failPage = 1
  await dialog.getByRole('radio',{name:'指定',exact:true}).click()
  await dialog.getByLabel('页码，如 1-2,4').fill('2')
  await dialog.getByRole('alert').waitFor()
  assert.equal(await svg.locator('[data-print-paths]').count(),0)
  failPage = -1
  await dialog.getByRole('button',{name:'重试预览',exact:true}).click()
  await visiblePath(1)
  await dialog.getByLabel('页码，如 1-2,4').fill('999')
  await page.waitForFunction(() => !document.querySelector('[data-print-paths]'))
  assert.ok(requests.some(r=>r.index===3),'second source page is fetched by output index')
  assert.ok(requests.every(r=>r.space==='page'))
  assert.deepEqual(errors,[])
  console.log('PASS: real binary paths, four output pages, current continuation, placement, four element corners, page-space axis reversals, failure/retry and empty selection')
} finally {
  await browser?.close()
  await server.close()
}
