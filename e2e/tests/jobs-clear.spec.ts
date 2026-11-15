import { test, expect } from '@playwright/test'

// List operations only: no connection or command is sent to a physical machine.
test.use({ storageState: { cookies: [], origins: [] } })

test('deferred history deletion after clearing does not report a false failure', async ({ page }, info) => {
  const job = { id: 'deferred-clear', name: '延迟删除记录', status: 'done', created_at: 1700000000,
    finished_at: 1700000010, total_lines: 10, acked_line: 10, est_s: 1 }
  let cleared = false
  let deletes = 0
  await page.route('**/api/v1/jobs?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    return route.fulfill({ json: cleared || status === 'queued' ? [] : [job] })
  })
  await page.route('**/api/v1/jobs/clear', (route) => {
    expect(route.request().postDataJSON()).toEqual({ scope: 'history' })
    expect(deletes).toBe(0)
    cleared = true
    return route.fulfill({ json: { removed_ids: [job.id], skipped_ids: [] } })
  })
  await page.route(`**/api/v1/jobs/${job.id}`, (route) => {
    expect(route.request().method()).toBe('DELETE')
    expect(cleared).toBeTruthy()
    deletes++
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '任务不存在' } } })
  })
  await page.goto('/jobs')
  if (info.project.name.includes('mobile')) await page.getByRole('radio', { name: '历史', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: `选择「${job.name}」` })).toBeVisible()
  await page.clock.install()
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除记录', exact: true }).click()
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清空已结束记录', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByText('已清理 1 个任务', { exact: true })).toBeVisible()
  // The list refresh happens in onSettled, after the DELETE result has been handled.
  const refreshed = page.waitForResponse((r) => deletes === 1 && new URL(r.url()).pathname === '/api/v1/jobs')
  await page.clock.fastForward(5001)
  await refreshed
  expect(deletes).toBe(1)
  await expect(page.getByText('删除任务失败', { exact: true })).toHaveCount(0)
  await expect(page.getByText('还没有任务记录', { exact: true })).toBeVisible()
})

test('clearing queued jobs persists on server and updates another open page', async ({ page, context, request }, info) => {
  const name = `clear-persist-${Date.now()}`
  const imported = await request.post('/api/v1/import/gcode', { multipart: {
    file: { name: `${name}.gcode`, mimeType: 'text/plain', buffer: Buffer.from('G21\nG90\nG0 X0 Y0\nG1 X1 Y1 F600\n') },
  } })
  expect(imported.ok()).toBeTruthy()
  const file = (await imported.json()).file.id
  const created = await request.post('/api/v1/jobs', { data: { source: { file_id: file }, name, start: false } })
  expect(created.ok()).toBeTruthy()
  const job = await created.json()
  const other = await context.newPage()
  for (const tab of [page, other]) {
    await tab.goto('/jobs')
    if (info.project.name.includes('mobile')) await tab.getByRole('radio', { name: /队列/ }).click()
    await expect(tab.getByRole('checkbox', { name: `选择「${name}」` })).toBeVisible()
  }
  await page.getByRole('checkbox', { name: `选择「${name}」` }).check()
  await page.getByRole('button', { name: '删除选中', exact: true }).first().click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(other.getByRole('checkbox', { name: `选择「${name}」` })).toHaveCount(0)
  expect((await request.get(`/api/v1/jobs/${job.id}`)).status()).toBe(404)
  await page.reload()
  if (info.project.name.includes('mobile')) await page.getByRole('radio', { name: /队列/ }).click()
  await expect(page.getByRole('checkbox', { name: `选择「${name}」` })).toHaveCount(0)
})

test('queue and history selection, server clearing, reload and errors', async ({ page }, info) => {
  const mobile = info.project.name.includes('mobile')
  let jobs = [
    { id: 'q1', name: '待打印甲', status: 'queued' },
    { id: 'q2', name: '待打印乙', status: 'queued' },
    { id: 'd1', name: '历史完成', status: 'done' },
    { id: 'f1', name: '历史失败', status: 'failed' },
    { id: 'r1', name: '正在打印', status: 'running' },
  ].map((j) => ({ ...j, created_at: 1700000000, finished_at: 1700000010, total_lines: 10, acked_line: 10, est_s: 1 }))
  const requests: object[] = []
  let fail = false
  await page.route('**/api/v1/jobs?*', (route) => {
    const status = new URL(route.request().url()).searchParams.get('status')
    return route.fulfill({ json: jobs.filter((j) => !status || status.split(',').includes(j.status)) })
  })
  await page.route('**/api/v1/jobs/clear', async (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    if (fail) return route.fulfill({ status: 409, json: { error: { code: 'job_active', message: '任务状态发生变化' } } })
    const eligible = jobs.filter((j) => body.scope === 'queued' ? j.status === 'queued' : ['done', 'failed', 'aborted'].includes(j.status))
    const removed = eligible.filter((j) => !body.ids || body.ids.includes(j.id)).map((j) => j.id)
    jobs = jobs.filter((j) => !removed.includes(j.id))
    await route.fulfill({ json: { removed_ids: removed, skipped_ids: [] } })
  })
  await page.goto('/jobs')
  if (mobile) await page.getByRole('radio', { name: /队列/ }).click()
  await page.getByRole('checkbox', { name: '选择「待打印甲」' }).check()
  await expect(page.getByRole('checkbox', { name: '全选当前待打印任务' })).toHaveJSProperty('indeterminate', true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('queue-selection.png'), fullPage: true })
  await page.getByRole('button', { name: '删除选中', exact: true }).filter({ visible: true }).first().click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '选择「待打印甲」' })).toHaveCount(0)
  expect(requests[0]).toEqual({ scope: 'queued', ids: ['q1'] })
  await page.reload()
  if (mobile) await page.getByRole('radio', { name: /队列/ }).click()
  await expect(page.getByRole('checkbox', { name: '选择「待打印甲」' })).toHaveCount(0)
  await page.getByRole('button', { name: '清空待打印', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByText('队列是空的')).toBeVisible()
  expect(requests[1]).toEqual({ scope: 'queued' })
  if (mobile) await page.getByRole('radio', { name: '历史', exact: true }).click()
  await page.getByPlaceholder('搜索任务').fill('完成')
  await page.getByRole('checkbox', { name: '全选当前历史记录' }).check()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: info.outputPath('history-selection.png'), fullPage: true })
  fail = true
  await page.getByRole('button', { name: '删除选中', exact: true }).filter({ visible: true }).last().click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('清理任务失败', { exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: '选择「历史完成」' })).toBeChecked()
  fail = false
  await page.getByRole('button', { name: '清空已结束记录', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '选择「历史完成」' })).toHaveCount(0)
  expect(requests.at(-1)).toEqual({ scope: 'history' })
  expect(jobs.map((j) => j.id)).toEqual(['r1'])
})
