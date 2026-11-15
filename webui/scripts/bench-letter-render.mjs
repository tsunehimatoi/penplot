// Run with a directory of real PPL1 pages and meta.json ({pages:N}); no personal text is stored here.
// node scripts/bench-letter-render.mjs ../build/letter-perf
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const directory = path.resolve(process.argv[2] ?? '../build/letter-perf')
const meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'))
const html = `<!doctype html><html><body><div id="root" style="height:800px;width:120px;overflow:auto"></div><script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { buildPathPreview } from '/src/features/studio/path-data.ts'
import { convertPathBuffer } from '/src/features/studio/path-conversion.ts'
import { PagesList } from '/src/features/studio/panels/navigator.tsx'
import { emptyDoc, makeFlow } from '/src/features/studio/model.ts'
import { lastKeys } from '/src/features/studio/actions.ts'
import { useStudio } from '/src/features/studio/store.ts'
import { useRender } from '/src/features/studio/render-engine.ts'
import '/src/index.css'
const h = React.createElement, root = createRoot(document.getElementById('root'))
const frame = () => new Promise(requestAnimationFrame)
window.ready = Promise.all(Array.from({length:${meta.pages}}, (_, i) => fetch('/bench-data/' + i).then(r => r.arrayBuffer())))
window.run = async (optimized) => {
  const buffers = (await window.ready).map(b => b.slice(0))
  const gaps = [], longTasks = []
  let running = true, last = performance.now()
  const sample = t => { gaps.push(t - last); last = t; if (running) requestAnimationFrame(sample) }
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)))
  observer.observe({type:'longtask'})
  requestAnimationFrame(sample)
  await frame()
  const start = performance.now()
  let pages
  if (optimized) {
    pages = new Array(buffers.length)
    let index = 0
    await Promise.all(Array.from({length:4}, async () => {
      while (index < buffers.length) {
        const i = index++
        pages[i] = await convertPathBuffer(buffers[i])
      }
    }))
  } else pages = buffers.map(buildPathPreview)
  const conversionMs = performance.now() - start
  const doc = emptyDoc('performance')
  const flow = makeFlow(null, 'benchmark')
  doc.pages[0].elements = [flow]
  lastKeys.set(flow.id, 'perf')
  useRender.getState().set('perf', {status:'ok', pages, at:1})
  useStudio.setState({doc})
  const mount = performance.now()
  flushSync(() => root.render(optimized ? h(PagesList) : h('div', null, ...pages.map((p,i) =>
    h('div', {key:i, style:{padding:'10px'}}, h('svg', {width:54, height:76, viewBox:'0 0 209 296'},
      h('path', {d:p.d, fill:'none', stroke:'black', strokeWidth:0.8, vectorEffect:'non-scaling-stroke'})))))))
  for (let i=0;i<12;i++) await frame()
  const result = {conversionMs, mountAndPaintMs:performance.now()-mount, maxFrameGapMs:Math.max(...gaps),
    longTaskCount:longTasks.length, maxLongTaskMs:Math.max(0,...longTasks), mountedPaths:document.querySelectorAll('#root path').length,
    svgCharacters:pages.reduce((n,p)=>n+p.d.length,0)}
  window.previews = pages
  running = false
  observer.disconnect()
  return result
}
</script></body></html>`
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'letter-performance-fixture', configureServer(vite) {
    vite.middlewares.use('/bench-data', (req, res) => {
      const index = Number(req.url.slice(1))
      if (!Number.isInteger(index) || index < 0 || index >= meta.pages) { res.statusCode = 404; res.end(); return }
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(fs.readFileSync(path.join(directory, `${index}.bin`)))
    })
    vite.middlewares.use('/letter-bench', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/letter-bench', html))
    })
  },
}] })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const results = {}
  for (const optimized of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
    page.on('pageerror', e => { throw e })
    await page.route('**/api/v1/**', route => route.fulfill({ json: [] }))
    await page.routeWebSocket('**/api/v1/ws', () => {})
    await page.goto(`${server.resolvedUrls.local[0]}letter-bench`)
    await page.waitForFunction(() => !!window.run)
    results[optimized ? 'optimized' : 'baseline'] = await page.evaluate(optimized => window.run(optimized), optimized)
    if (optimized) {
      const count = await page.locator('#root [role="option"]').count()
      assert.equal(count, meta.pages)
      assert.ok(results.optimized.mountedPaths < meta.pages / 2, 'offscreen SVGs must stay unmounted')
      const last = page.getByRole('option', { name: `第 ${meta.pages} 页`, exact: true })
      await last.scrollIntoViewIfNeeded()
      await last.locator('path').waitFor()
      await last.click()
      assert.equal(await last.getAttribute('aria-selected'), 'true')
      // Worker output must exactly match the old conversion for every real page.
      assert.equal(await page.evaluate(async () => {
        const { buildPathPreview } = await import('/src/features/studio/path-data.ts')
        return (await window.ready).every((b,i) => JSON.stringify(buildPathPreview(b)) === JSON.stringify(window.previews[i]))
      }), true)
    }
    await page.close()
  }
  const report = JSON.stringify({fixture:meta, ...results}, null, 2)
  fs.writeFileSync(path.join(directory, 'result.json'), report + '\n')
  console.log(report)
} finally { await browser?.close(); await server.close() }
