import { expect, test, type Page } from '@playwright/test'

// List operations only: no connection or command is sent to a physical machine.
test.use({ storageState: { cookies: [], origins: [] } })

async function openJobs(page: Page) {
  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await expect(page).toHaveURL(/\/studio/)
  await page.goto('/jobs')
}

test('clearing the queue persists on the server and updates another open page', async ({ page, context, request }) => {
  const name = '清空待打印回归-' + Date.now()
  const imported = await request.post('/api/v1/import/gcode', { multipart: {
    file: { name: name + '.gcode', mimeType: 'text/plain', buffer: Buffer.from('G21\nG90\nG0 X0 Y0\nG1 X1 Y1 F600\n') },
  } })
  await expect(imported).toBeOK()
  const file = (await imported.json()).file.id
  const created = await request.post('/api/v1/jobs', { data: { source: { file_id: file }, name, start: false } })
  await expect(created).toBeOK()
  const job = await created.json()

  await openJobs(page)
  const other = await context.newPage()
  await other.goto('/jobs')
  for (const tab of [page, other]) await expect(tab.getByRole('tab', { name: new RegExp(name) })).toBeVisible()
  await page.getByRole('button', { name: '清空待打印', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByText('已清理 1 个任务', { exact: true })).toBeVisible()
  await expect(other.getByRole('tab', { name: new RegExp(name) })).toHaveCount(0)
  expect((await request.get('/api/v1/jobs/' + job.id)).status()).toBe(404)
  await page.reload()
  await expect(page.getByText('还没有打印任务', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '清空待打印', exact: true })).toBeDisabled()
})

test('grouped task page clears each scope independently and preserves active jobs', async ({ page }) => {
  const running = { id: 'r1', name: '正在打印甲', status: 'running' }
  const queued = { id: 'q1', name: '待打印甲', status: 'queued' }
  const done = { id: 'd1', name: '历史完成', status: 'done' }
  const failed = { id: 'f1', name: '历史失败', status: 'failed' }
  let jobs = [running, queued, done, failed]
  const requests: object[] = []
  let fail = false
  await page.route('**/api/v1/jobs?*', (route) => route.fulfill({
    json: jobs.map((job) => ({ ...job, created_at: 1700000000, total_lines: 10, acked_line: 0, est_s: 1 })),
  }))
  await page.route('**/api/v1/jobs/clear', async (route) => {
    const body = route.request().postDataJSON()
    requests.push(body)
    if (fail) return route.fulfill({ status: 409, json: { error: { code: 'job_active', message: '任务状态发生变化' } } })
    const statuses = body.scope === 'queued' ? ['queued'] : ['done', 'failed', 'aborted']
    const removed = jobs.filter((job) => statuses.includes(job.status)).map((job) => job.id)
    jobs = jobs.filter((job) => !removed.includes(job.id))
    await route.fulfill({ json: { removed_ids: removed, skipped_ids: [] } })
  })

  await openJobs(page)
  const dialog = page.getByRole('alertdialog')
  const clearHistory = page.getByRole('button', { name: '清空已结束记录', exact: true })
  const clearQueue = page.getByRole('button', { name: '清空待打印', exact: true })
  const tab = (name: string) => page.getByRole('tab', { name: new RegExp(name) })

  await clearQueue.click()
  await expect(dialog).toContainText('正在打印的任务会保留')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  expect(requests).toEqual([])
  await expect(tab(queued.name)).toBeVisible()

  fail = true
  await clearHistory.click()
  await dialog.getByRole('button', { name: '清空', exact: true }).click()
  await expect(page.getByText('清理任务失败', { exact: true })).toBeVisible()
  await expect(tab(done.name)).toBeVisible()

  fail = false
  await clearHistory.click()
  await dialog.getByRole('button', { name: '清空', exact: true }).click()
  await expect(tab(done.name)).toHaveCount(0)
  await expect(tab(failed.name)).toHaveCount(0)
  await expect(tab(queued.name)).toBeVisible()
  await expect(tab(running.name)).toBeVisible()

  await clearQueue.click()
  await dialog.getByRole('button', { name: '清空', exact: true }).click()
  await expect(tab(queued.name)).toHaveCount(0)
  await expect(tab(running.name)).toBeVisible()
  expect(requests).toEqual([{ scope: 'history' }, { scope: 'history' }, { scope: 'queued' }])
})
