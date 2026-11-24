import { expect, test } from '@playwright/test'
import { uniq } from '../helpers/env'

test.use({ storageState: { cookies: [], origins: [] } })

test('flow text keeps existing strokes and follows ruled continuation pages', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) < 768, 'desktop page navigator')
  const name = uniq('E2E续页')
  const response = await page.request.post('/api/v1/projects', { data: {
    name,
    doc: {
      name,
      paper: { spec: { name: '续页测试纸', width_mm: 150, height_mm: 80, margins: { l: 0, r: 0, t: 0, b: 0 } } },
      pages: [{
        id: 'p1',
        elements: [{
          id: 'letter', type: 'flow_text',
          props: {
            text: '<p>AA</p><p>B</p>', format: 'html', font_id: 'builtin', line_num: 2, seed: 42,
            text_size: 0.45, jitter: { randomFirstPos: 2, randomFontSize: [0.8, 1.2], randomY: 0.03 },
          },
        }],
      }],
    },
  } })
  await expect(response).toBeOK()
  const project = await response.json()
  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await expect(page).toHaveURL(/\/studio/)
  await page.goto(`/studio/${project.id}`)
  const canvas = page.locator('[data-studio-canvas]')
  const path = canvas.locator('g[data-el="letter"] > path')
  const textbox = canvas.locator('[data-inline-editor="letter"] [role="textbox"]')
  const pages = page.getByRole('listbox', { name: '页面' })
  const first = pages.getByRole('option', { name: '第 1 页' })
  const second = pages.getByRole('option', { name: '第 2 页' })
  await expect(first.locator('svg path')).toBeAttached()
  await textbox.press('Control+End')
  const initialInk = (await path.getAttribute('d'))!
  await textbox.press('A')
  await expect.poll(async () => (await path.getAttribute('d'))?.startsWith(initialInk)).toBe(true)
  await expect(path).not.toHaveAttribute('d', initialInk)
  const firstPageInk = await path.getAttribute('d')

  await textbox.press('Enter')
  await expect(second).toHaveAttribute('aria-selected', 'true')
  await expect(textbox).toBeFocused()
  await expect(path).toHaveCount(0)
  await expect(textbox.locator('..')).toHaveCSS('overflow-y', 'clip')
  await textbox.press('C')
  await expect(second.locator('svg path')).toBeAttached()
  await expect(path).toHaveAttribute('d', (await second.locator('svg path').getAttribute('d'))!)

  await first.click()
  await expect(path).toBeAttached()
  const inkBeforeAnimation = await path.getAttribute('d')
  expect(inkBeforeAnimation).toBeTruthy()
  expect(firstPageInk?.length).toBeGreaterThan((await second.locator('svg path').getAttribute('d'))!.length)
  await second.click()
  await expect(path).not.toHaveAttribute('d', inkBeforeAnimation!)
  const outputPaths = page.waitForResponse((res) => /\/render\/[^/]+\/pages\/1\/paths$/.test(new URL(res.url()).pathname))
  await page.getByRole('button', { name: '笔顺预览' }).click()
  await expect(page.getByRole('group', { name: '笔顺动画' })).toBeVisible()
  expect((await outputPaths).ok()).toBe(true)
  await expect(path).toHaveCount(0)
  await expect(textbox).toHaveCount(0)
})
