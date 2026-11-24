// Browser regression for physical page navigation and editable letter continuations.
// Run: node scripts/test-letter-pages.mjs (uses an isolated Vite server, no backend).
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
import { PagesList, LayersList } from '/src/features/studio/panels/navigator.tsx'
import { Canvas } from '/src/features/studio/canvas/canvas.tsx'
import { PrintSheet } from '/src/features/studio/sheets/print-sheet.tsx'
import { ExportSheet } from '/src/features/studio/sheets/export-sheet.tsx'
import { Inspector } from '/src/features/studio/inspector/inspector.tsx'
import { useStudio } from '/src/features/studio/store.ts'
import { useRender } from '/src/features/studio/render-engine.ts'
import { lastKeys, selectAll, duplicatePage, insertShape, copySelection, paste, deleteSelection } from '/src/features/studio/actions.ts'
import { emptyDoc, makeFlow, makeShape, newPage, FALLBACK_PAPER, DEFAULT_ORIGIN } from '/src/features/studio/model.ts'
import '/src/index.css'
const h = React.createElement
const doc = emptyDoc('分页回归')
doc.print.origin = { ...DEFAULT_ORIGIN, anchor: 'content' }
const flow = makeFlow(null, '<p>第一页</p><div data-pagebreak="true" style="page-break-after: always"></div><p>第二页</p><div data-pagebreak="true" style="page-break-after: always"></div><p>第三页</p>', 'html')
flow.id = 'letter'
doc.pages[0].elements = [flow, { ...makeShape('rect', 5, 5, 1), id: 'shape' }]
doc.pages.push(newPage())
const paths = [0, 1, 2].map(i => ({ d: 'M40 ' + (40 + i * 20) + 'h100', bbox: [40, 40 + i * 20, 140, 50 + i * 20] }))
lastKeys.set(flow.id, 'letter-render')
useRender.getState().set('letter-render', { status: 'ok', pages: paths, at: 1 })
useStudio.setState({ doc, project: { id: 'test-project', name: '分页回归', rev: 1 } })
window.fixture = { useStudio, useRender, lastKeys, selectAll, duplicatePage, insertShape, copySelection, paste, deleteSelection, paths }
function TestCanvas() {
  const origin = useStudio(s => s.doc.print.origin)
  return h(Canvas, { ...props, origin })
}
const props = { paper: FALLBACK_PAPER, origin: DEFAULT_ORIGIN, workArea: null }
function OutputSheets() {
  const [printing, setPrinting] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  fixture.openPrint = () => setPrinting(true)
  fixture.openExport = () => setExporting(true)
  return h(React.Fragment, null,
    h(PrintSheet, { ...props, open: printing, onOpenChange: setPrinting, onOpenPosition() {} }),
    h(ExportSheet, { open: exporting, onOpenChange: setExporting }))
}
createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client: queryClient },
  h(MemoryRouter, null, h(TooltipProvider, null, h('div', { style: { display: 'flex', height: '850px' } },
    h('div', { id: 'pages', style: { width: '120px' } }, h(PagesList)),
    h('div', { id: 'canvas', style: { width: '700px', position: 'relative' } }, h(TestCanvas)),
    h('div', { id: 'inspector', style: { width: '340px' } }, h(Inspector, { ...props, originOverridden: false, profileName: '', onOpenPaper() {}, onOpenPosition() {} })),
    h('div', { id: 'layers' }, h(LayersList)), h(OutputSheets)
  )))))
</script></body></html>`

const server = await createServer({
  server: { host: '127.0.0.1', port: 0, open: false },
  plugins: [{ name: 'letter-test-fixture', configureServer(vite) {
    vite.middlewares.use('/letter-pages-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/letter-pages-test', html))
    })
  } }],
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  page.setDefaultTimeout(15000)
  page.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()) })
  const errors = []
  page.on('pageerror', e => { errors.push(e.message); console.error(e.message) })
  await page.routeWebSocket('**/api/v1/ws', () => {})
  await page.route('**/api/v1/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/paths')) {
      const binary = Buffer.alloc(32)
      binary.writeUInt32LE(0x314c5050, 0); binary.writeUInt32LE(1, 4)
      binary.writeUInt32LE(0, 8); binary.writeUInt32LE(2, 12)
      ;[40, 40, 140, 40].forEach((n,i) => binary.writeFloatLE(n,16+i*4))
      return route.fulfill({body:binary, contentType:'application/octet-stream'})
    }
    if (pathname.endsWith('/profiles')) return route.fulfill({ json: [{id:'test', name:'Test', is_active:true, doc:{type:'Grbl', settings:{}, axes:{}, grbl:{type:'Servo'}, advanced:{}, work_area:{w_mm:0,h_mm:0}}}] })
    if (pathname.endsWith('/render')) return route.fulfill({ json: {rid:'render-test', pages:[0,1,2].map(index => ({index, source_page:0, bbox:[40,40+20*index,140,50+20*index], machine_bbox:[0,-10,100,0], est_s:10, out_of_work_area:false, stats:{strokes:1,draw_mm:100,travel_mm:0}, warnings:{missing_glyphs:[],messages:[],clipped:false,overflow:false}}))} })
    if (pathname.endsWith('/export')) return route.fulfill({ body: 'test download', contentType:'application/octet-stream', headers:{'Content-Disposition':'attachment; filename="test.bin"'} })
    return route.fulfill({ json: [] })
  })
  await page.goto(`${server.resolvedUrls.local[0]}letter-pages-test`)
  const options = page.locator('#pages [role="option"]')
  await options.nth(3).waitFor()
  assert.deepEqual(await options.evaluateAll(els => els.map(e => e.getAttribute('aria-label'))), ['第 1 页', '第 2 页', '第 3 页', '第 4 页'])
  await page.evaluate(() => fixture.useStudio.getState().setStrokePreview(true))
  for (const number of [1, 2, 3]) {
    await page.getByRole('option', { name: '第 ' + number + ' 页', exact: true }).click()
    const hit = page.locator('#canvas [data-el-id="letter"]')
    await hit.click({ position: { x: 30, y: 30 } })
    await page.locator('#inspector').getByRole('heading', { name: '文本框', exact: true, level: 2 }).waitFor()
    assert.deepEqual(await page.evaluate(() => fixture.useStudio.getState().selection), ['letter'])
    assert.equal(await page.locator('#canvas [data-el="letter"] path').first().getAttribute('d'), 'M40 ' + (40 + (number - 1) * 20) + 'h100')
    assert.equal(await page.locator('#canvas polygon').count() > 0, true, 'selection outline on every page')
  }
  await page.evaluate(() => fixture.useStudio.getState().setStrokePreview(false))
  // Every letter page anchors to the component frame, and its origin can be dragged.
  for (const number of [1, 2, 3]) {
    await page.evaluate(() => fixture.useStudio.getState().edit(d => {
      d.print.origin.offset_x_mm = 0
      d.print.origin.offset_y_mm = 0
    }))
    await page.getByRole('option', { name: '第 ' + number + ' 页', exact: true }).click()
    const marker = page.locator('#canvas [data-handle="origin"]')
    await marker.waitFor()
    const position = await marker.evaluate(el => {
      const t = el.transform.baseVal.getItem(0).matrix
      const z = fixture.useStudio.getState().zoom
      return { x: (t.e - z.panX) / z.zoom, y: (t.f - z.panY) / z.zoom, zoom: z.zoom }
    })
    assert.ok(Math.abs(position.x - 31.8) < 0.001)
    assert.ok(Math.abs(position.y - 25.4) < 0.001)
    const box = await marker.boundingBox()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.keyboard.down('Control')
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 10 * position.zoom, y + 15 * position.zoom, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.up('Control')
    const origin = await page.evaluate(() => fixture.useStudio.getState().doc.print.origin)
    assert.equal(origin.offset_x_mm, 10)
    assert.equal(origin.offset_y_mm, 15)
    const moved = await marker.evaluate(el => {
      const t = el.transform.baseVal.getItem(0).matrix
      const z = fixture.useStudio.getState().zoom
      return { x: (t.e - z.panX) / z.zoom, y: (t.f - z.panY) / z.zoom }
    })
    assert.ok(Math.abs(moved.x - position.x - 10) < 0.001)
    assert.ok(Math.abs(moved.y - position.y - 15) < 0.001)
  }
  assert.equal(await page.locator('#layers [role="option"]').count(), 1, 'continuation only lists its letter')
  await page.evaluate(() => fixture.selectAll())
  assert.deepEqual(await page.evaluate(() => fixture.useStudio.getState().selection), ['letter'])
  await page.locator('#canvas [data-el-id="letter"]').dblclick({ position: { x: 80, y: 80 } })
  const inlineTextbox = page.locator('#canvas').getByLabel('文本框内容')
  await inlineTextbox.waitFor()
  await inlineTextbox.focus()
  await page.keyboard.type('修改后的文本框')
  assert.ok((await page.evaluate(() => fixture.useStudio.getState().doc.pages[0].elements[0].props.text)).includes('修改后的文本框'))
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().doc.pages[0].elements[0].props.format), 'html')
  await page.evaluate(() => fixture.useStudio.getState().undo())
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 2, 'undo stays on the continuation')
  await page.evaluate(() => fixture.useStudio.getState().redo())
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 2, 'redo stays on the continuation')
  await page.evaluate(() => fixture.useStudio.getState().setInlineEdit(null))
  await page.evaluate(() => fixture.useStudio.getState().select([]))
  await page.getByRole('button', { name: '编辑文本框…' }).click()
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 2, 'document inspector edits this continuation')
  assert.deepEqual(await page.evaluate(() => fixture.useStudio.getState().selection), ['letter'])
  await page.evaluate(() => fixture.useStudio.getState().setInlineEdit(null))
  await page.evaluate(() => fixture.openPrint())
  const printDialog = page.getByRole('dialog', { name: '打印', exact: true })
  await printDialog.getByRole('radio', { name: '当前页', exact: true }).click()
  const printRequest = page.waitForRequest(r => new URL(r.url()).pathname.endsWith('/export'))
  await printDialog.getByRole('button', { name: '导出 G 代码', exact: true }).click()
  assert.deepEqual((await printRequest).postDataJSON().pages, [2], 'current page means the third physical page only')
  await printDialog.getByRole('radio', { name: '指定', exact: true }).click()
  await printDialog.getByLabel('页码，如 1-2,4').fill('999')
  assert.equal(await printDialog.getByRole('button', { name: '导出 G 代码', exact: true }).isDisabled(), true, 'invalid range must not export every page')
  await printDialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => fixture.openExport())
  const exportDialog = page.getByRole('dialog', { name: '导出', exact: true })
  await exportDialog.getByRole('radio', { name: 'PNG', exact: true }).click()
  await exportDialog.getByRole('radio', { name: '全部页', exact: true }).click()
  const exportRequest = page.waitForRequest(r => new URL(r.url()).pathname.endsWith('/export'))
  await exportDialog.getByRole('button', { name: '导出', exact: true }).click()
  const exportBody = (await exportRequest).postDataJSON()
  assert.equal(exportBody.pages, 'all')
  assert.equal(exportBody.format, 'png')
  await exportDialog.waitFor({ state:'hidden' })
  await page.evaluate(() => {
    fixture.useRender.getState().setPage({ result: { rid:'animation-test', pages: [0,1,2].map(index => ({index, source_page:0, out_of_work_area:false, warnings:{clipped:index===0, messages:[]}})) } })
    fixture.useStudio.getState().setView({page:0, sub:0})
    fixture.useStudio.getState().select([])
  })
  await page.getByText('本页有内容超出纸张。', {exact:true}).waitFor()
  await page.getByRole('option', {name:'第 2 页',exact:true}).click()
  assert.equal(await page.getByText('本页有内容超出纸张。', {exact:true}).count(), 0)
  await page.evaluate(() => fixture.useStudio.getState().setAnimate(true))
  const progress = page.getByRole('slider', {name:'进度',exact:true})
  await progress.focus()
  await progress.press('End')
  assert.equal(await progress.getAttribute('aria-valuenow'), '1000')
  await page.getByRole('option', {name:'第 3 页',exact:true}).click()
  assert.ok(Number(await progress.getAttribute('aria-valuenow')) < 200, 'new page starts its own stroke animation')
  await page.getByRole('button', {name:'关闭笔顺',exact:true}).click()
  await page.evaluate(() => fixture.useStudio.getState().select(['letter']))
  const addedId = await page.evaluate(() => {
    fixture.insertShape('rect', {x:90,y:100}, {w:12,h:15})
    return fixture.useStudio.getState().selection[0]
  })
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 2)
  assert.equal(await page.evaluate(id => fixture.useStudio.getState().doc.pages[0].elements.find(e => e.id === id).page_offset, addedId), 2)
  await page.locator('#canvas [data-el-id="' + addedId + '"]').waitFor()
  await page.evaluate(() => fixture.copySelection())
  await page.getByRole('option', {name:'第 1 页',exact:true}).click()
  assert.equal(await page.locator('#canvas [data-el-id="' + addedId + '"]').count(), 0)
  await page.getByRole('option', {name:'第 2 页',exact:true}).click()
  await page.evaluate(() => fixture.paste())
  assert.equal(await page.evaluate(() => {
    const s = fixture.useStudio.getState()
    return s.doc.pages[0].elements.find(e => e.id === s.selection[0]).page_offset
  }), 1)
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 1)
  await page.evaluate(() => fixture.deleteSelection())
  await page.getByRole('option', {name:'第 3 页',exact:true}).click()
  await page.evaluate(id => { fixture.useStudio.getState().select([id]); fixture.deleteSelection() }, addedId)
  await page.evaluate(() => fixture.useStudio.getState().select(['letter']))
  // A new render key must not temporarily collapse pages or lose the selected continuation.
  await page.evaluate(() => {
    fixture.useStudio.getState().setStrokePreview(true)
    fixture.lastKeys.set('letter', 'next-render')
    fixture.useStudio.getState().edit(d => { d.pages[0].elements[0].props.seed += 1 })
    fixture.useRender.getState().set('next-render', { status: 'pending', at: 2 })
  })
  await page.waitForFunction(() => document.querySelector('#pages [aria-selected="true"]')?.getAttribute('aria-label') === '第 3 页')
  assert.equal(await options.count(), 4)
  assert.equal(await page.locator('#canvas [data-el="letter"] path').count(), 1)
  await page.evaluate(() => fixture.useRender.getState().set('next-render', { status:'error', error:'测试渲染失败', at:2 }))
  await page.locator('#canvas text').filter({hasText:'测试渲染失败'}).waitFor()
  assert.equal(await options.count(), 4, 'a failed render must not discard continuation pages')
  assert.equal(await page.evaluate(() => fixture.useStudio.getState().view.sub), 2)
  // Shortening the text clamps to the last remaining page, and the following page is renumbered.
  await page.evaluate(() => fixture.useRender.getState().set('next-render', { status: 'ok', pages: fixture.paths.slice(0, 1), at: 3 }))
  await page.waitForFunction(() => fixture.useStudio.getState().view.sub === 0)
  assert.deepEqual(await options.evaluateAll(els => els.map(e => e.getAttribute('aria-label'))), ['第 1 页', '第 2 页'])
  assert.deepEqual(await page.evaluate(() => fixture.useStudio.getState().selection), ['letter'])
  await page.evaluate(() => fixture.duplicatePage(0))
  assert.ok((await page.evaluate(() => fixture.useStudio.getState().doc.pages[1].elements.find(e => e.type === 'flow_text').props.text)).includes('修改后的文本框'))
  assert.notEqual(await page.evaluate(() => fixture.useStudio.getState().doc.pages[1].elements.find(e => e.type === 'flow_text').id), 'letter')
  assert.deepEqual(errors, [])
  console.log('PASS: pagination, selection, origin dragging, undo/redo, current-page print, PNG range, warnings, animation reset, copy letter, pending/error render and shrinking pages')
} finally {
  await browser?.close()
  await server.close()
}
