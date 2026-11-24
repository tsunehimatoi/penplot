import { expect, test } from '@playwright/test'
import { uniq } from '../helpers/env'

test.use({ storageState: { cookies: [], origins: [] } })

test('paste omits empty clipboard list shells and preserves real lists', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) < 768, 'desktop studio editor')
  const name = uniq('E2E粘贴')
  const emptyList = '<ol><li><br></li></ol>'
  const response = await page.request.post('/api/v1/projects', { data: {
    name,
    doc: { name, pages: [{ id: 'p1', elements: [{
      id: 'paste', type: 'flow_text',
      props: { text: emptyList, format: 'html', font_id: 'builtin', seed: 42 },
    }] }] },
  } })
  await expect(response).toBeOK()
  const project = await response.json()
  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await page.goto(`/studio/${project.id}`)

  const canvas = page.locator('[data-inline-editor="paste"]')
  const editor = canvas.getByRole('textbox')
  const source = canvas.locator('textarea')
  const latex = String.raw`0.05\text{ mg/L}`
  const markdown = [
    `**氨氮测定结果**：$${latex}$`,
    '**仪器读数照片记录**：',
    '测定方法：`氨氮(纳氏试剂法)`',
    '显示浓度：`0.05 mg/L`',
  ].join('\n')
  const paste = async (target: typeof editor, plain: string, html = '', replaceAll = true) => {
    await target.evaluate((node, data) => {
      node.focus()
      if (node instanceof HTMLTextAreaElement) node.select()
      else if (data.replaceAll) window.getSelection()?.selectAllChildren(node)
      else window.getSelection()?.collapse(node.querySelector('li')!, 0)
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', data.plain)
      if (data.html) clipboardData.setData('text/html', data.html)
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    }, { plain, html, replaceAll })
  }

  await editor.focus()
  await canvas.getByRole('radio', { name: '源码' }).click()
  await expect(source).toHaveValue('')
  await canvas.getByRole('radio', { name: '可视化' }).click()
  await paste(editor, markdown, emptyList + '<div>' + markdown.replaceAll('\n', '<br>') + '</div>', false)
  await expect(editor.locator('ol')).toHaveCount(0)
  await expect(editor.locator('.math-inline')).toHaveText(latex)
  await expect(editor.locator('code')).toHaveText(['氨氮(纳氏试剂法)', '0.05 mg/L'])

  await canvas.getByRole('radio', { name: '源码' }).click()
  await expect(source).toHaveValue(markdown)
  await paste(source, '第一项\n第二项', emptyList + '<ol><li>第一项</li><li>第二项</li></ol>')
  await expect(source).toHaveValue('1. 第一项\n2. 第二项')

  await canvas.getByRole('radio', { name: '可视化' }).click()
  await expect(editor.locator('ol > li')).toHaveText(['第一项', '第二项'])
  await paste(editor, '普通文本\n下一行')
  await expect(editor.locator('ol')).toHaveCount(0)
  await expect(editor.locator('p')).toHaveText(['普通文本', '下一行'])
})

test('report formulas retain their list placement without visible dollar delimiters', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) < 768, 'desktop studio editor')
  const name = uniq('E2E计算公式')
  const chloride = String.raw`\text{氯化物}=\frac{(V_2-V_1)\times0.5\times1000}{50\text{ mL}}=47\text{ mg/L}`
  const hardness = String.raw`P=\bar{V}_1\times\frac{1000.9}{V_2}`
  const markdown = [
    '- **氯化物含量计算**', '  $$' + chloride + '$$',
    '- **水中总硬度计算**', '  $$', '  ' + hardness, '  $$',
    '  $$H_T=0.0560P$$', '  （分别计算平行样）',
  ].join('\n')
  const response = await page.request.post('/api/v1/projects', { data: {
    name,
    doc: { name, pages: [{ id: 'p1', elements: [{
      id: 'report', type: 'flow_text',
      props: { text: markdown, format: 'markdown', font_id: 'builtin', seed: 42 },
    }] }] },
  } })
  await expect(response).toBeOK()
  const project = await response.json()
  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await expect(page).toHaveURL(/\/studio/)
  await page.goto(`/studio/${project.id}`)
  const editor = page.locator('[data-inline-editor="report"] [role="textbox"]')
  const items = editor.locator('ul > li')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0).locator('.math-display')).toHaveText(chloride)
  await expect(items.nth(1).locator('.math-display')).toHaveText([hardness, 'H_T=0.0560P'])
  await expect(items.nth(1).locator('p')).toHaveText('（分别计算平行样）')
  await expect(editor).not.toContainText('$')
})

test('source lines stay separate and a plotted formula is selected as one object', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) < 768, 'desktop studio editor')
  const name = uniq('E2E行与公式')
  const latex = String.raw`\frac{12}{34}\text{m}x`
  const response = await page.request.post('/api/v1/projects', { data: {
    name,
    doc: {
      name,
      paper: { spec: { name: '公式测试纸', width_mm: 150, height_mm: 80, margins: { l: 0, r: 0, t: 0, b: 0 } } },
      pages: [{ id: 'p1', elements: [{
        id: 'word-flow', name: '文本框', type: 'flow_text',
        props: {
          text: `Line A\nTemp: $${latex}$ tail\nLine C`,
          format: 'markdown', font_id: 'builtin', seed: 42, line_num: 5, text_size: 0.55,
          paragraph: { spe_type: 1, spe_value: 8, left: 0, right: 0 },
        },
      }] }],
    },
  } })
  await expect(response).toBeOK()
  const project = await response.json()
  const preview = await page.request.post(`/api/v1/projects/${project.id}/preview?wait=10`, { data: {} })
  await expect(preview).toBeOK()
  const { editor_layouts } = await preview.json()
  const layout = editor_layouts[0]
  expect(layout.lineAnchors.map((line: { x: number; y: number }) => [line.x, line.y])).toEqual([[0, 0], [0, 16], [0, 32]])
  const atom = layout.charBoxes.find((box: { atomic: boolean }) => box.atomic)
  expect(atom.endCharIdx - atom.charIdx).toBe(1)

  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await expect(page).toHaveURL(/\/studio/)
  const paths = page.waitForResponse((res) => res.url().includes('/paths-stream'))
  await page.goto(`/studio/${project.id}`)
  await (await paths).finished()
  const editor = page.locator('[data-inline-editor="word-flow"] [role="textbox"]')
  await expect(editor.locator('.math-inline')).toHaveAttribute('contenteditable', 'false')
  const ink = page.locator('g[data-el="word-flow"] > path')
  await expect(ink).toBeAttached()
  const clickFormula = async (fraction: number, double = false) => {
    const pt = await ink.evaluate((path, { x, y }) => {
      const point = new DOMPoint(x, y).matrixTransform((path as SVGPathElement).getScreenCTM()!)
      return { x: point.x, y: point.y }
    }, { x: atom.x + atom.w * fraction, y: atom.y + atom.h * 0.5 })
    if (double) await page.mouse.dblclick(pt.x, pt.y)
    else await page.mouse.click(pt.x, pt.y)
  }
  await clickFormula(0.5)
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(latex)
  await clickFormula(0.94)
  await page.keyboard.insertText('X')
  await expect(editor.locator('.math-inline')).toHaveText(latex)
  await expect(editor).toContainText(`${latex}X tail`)
  await page.keyboard.press('Control+s')
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/v1/projects/${project.id}`)).json()
    return saved.doc.pages[0].elements[0].props.editor_document?.blocks
      .flatMap((block: { children: { kind: string, text?: string }[] }) => block.children)
      .find((node: { kind: string }) => node.kind === 'inlineFormula')?.text
  }).toBe(latex)

  await clickFormula(0.5, true)
  const formulaEdit = page.getByRole('dialog', { name: '就地编辑公式' })
  await expect(formulaEdit).toBeVisible()
  await formulaEdit.getByLabel('数字 1').fill('56')
  await formulaEdit.getByLabel('字母 1').fill('y')
  await formulaEdit.getByLabel('文本 1').fill('cm')
  await formulaEdit.getByRole('button', { name: '应用公式' }).click()
  await expect(editor.locator('.math-inline')).toHaveText(String.raw`\frac{56}{34}\text{cm}y`)
  await expect(editor).toContainText('yX tail')

  await expect(editor).toBeFocused()
  await editor.press('Control+End')
  await editor.press('Shift+Enter')
  const canvasEditor = page.locator('[data-inline-editor="word-flow"]')
  await canvasEditor.getByRole('radio', { name: '源码' }).click()
  const markdown = canvasEditor.locator('textarea')
  await expect(markdown).toHaveValue(/Line C<br>$/)
  await markdown.fill((await markdown.inputValue()) + '\n\nExtra line')
  await canvasEditor.getByRole('radio', { name: '可视化' }).click()
  const sourceParagraph = editor.locator('p').filter({ hasText: 'Line C' })
  await expect(sourceParagraph.locator('br')).toHaveCount(3)
  await expect(editor.locator('p').filter({ hasText: 'Extra line' })).toBeAttached()
})

test('table border controls, glyph spacing, editable indentation and source views', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 1440) < 768, 'desktop studio editor')
  const name = uniq('E2E公式')
  const response = await page.request.post('/api/v1/projects', { data: {
    name,
    doc: {
      name,
      pages: [{ id: 'p1', elements: [{
        id: 'formula', type: 'flow_text',
        props: {
          text: '<table><tr><th>Unit</th><th>Value</th></tr><tr><td>A\u00a0\u200b</td><td>12</td></tr></table><p>Temperature: </p>',
          format: 'html', font_id: 'builtin', seed: 42,
          paragraph: { spe_type: 1, spe_value: 8, left: 5, indent_configured: true },
        },
      }] }],
    },
  } })
  await expect(response).toBeOK()
  const project = await response.json()
  await page.goto('/welcome')
  await page.getByRole('button', { name: '以后再说' }).click()
  await expect(page).toHaveURL(/\/studio/)
  const glyphBatch = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/glyphs'))
  await page.goto(`/studio/${project.id}`)
  expect((await glyphBatch).postDataJSON().text).not.toMatch(/[\s\u200b]/u)
  const editor = page.locator('[data-inline-editor="formula"]')
  const visual = editor.getByRole('textbox', { name: '文本框内容' })
  await visual.press('Control+End')

  const temperature = String.raw`16.4\,^\circ\text{C}`
  const typedRender = page.waitForRequest((request) => request.method() === 'POST' &&
    new URL(request.url()).pathname.endsWith('/preview') && request.postDataJSON()?.doc?.pages?.some(
      (entry: { elements: { props: { text: string } }[] }) => entry.elements.some((el) => el.props.text.includes(temperature)),
    ))
  await page.keyboard.insertText(temperature)
  await typedRender
  await page.keyboard.insertText(' ' + String.raw`$T_d=16.4^\circ\text{C}$`)

  await editor.getByRole('button', { name: '组件设置' }).click()
  const settings = page.getByRole('dialog', { name: '表格与公式设置' })
  await settings.getByLabel('组件').selectOption('0')
  await settings.getByLabel('边框').selectOption('grid')
  await settings.getByRole('button', { name: '应用' }).click()
  await expect(visual.locator('table')).toHaveAttribute('data-border', 'grid')
  await editor.getByRole('button', { name: '组件设置' }).click()
  await settings.getByLabel('组件').selectOption('2')
  await settings.getByLabel('边框').selectOption('box')
  await settings.getByRole('button', { name: '应用' }).click()
  const formula = visual.locator('.math-inline').filter({ hasText: 'T_d' })
  await expect(formula).toHaveAttribute('data-border', 'box')

  await editor.getByRole('radio', { name: '源码' }).click()
  const source = editor.locator('textarea')
  await expect(source).toHaveValue(/\| Unit \| Value \|/)
  await expect(editor.getByRole('radio', { name: 'H5' })).toHaveCount(0)
  await editor.getByRole('radio', { name: 'TXT' }).click()
  await expect(source).toHaveValue(/Unit\tValue/)
  await editor.getByRole('radio', { name: '可视化' }).click()
  await expect(visual.locator('table')).toHaveAttribute('data-border', 'grid')
  await expect(formula).toHaveAttribute('data-border', 'box')

  await editor.getByRole('button', { name: '表格边框', exact: true }).click()
  const borderEditor = page.getByRole('dialog', { name: '表格边框' })
  await borderEditor.getByRole('button', { name: '无边框' }).click()
  await borderEditor.getByRole('button', { name: '上框线' }).click()
  await borderEditor.getByRole('button', { name: '内部竖线' }).click()
  await borderEditor.getByRole('button', { name: '应用边框' }).click()
  await expect(visual.locator('table')).toHaveAttribute('data-border-edges', 'top vertical')
  const paragraph = visual.locator('p').filter({ hasText: 'Temperature:' })
  await visual.focus()
  await paragraph.evaluate((p) => {
    const range = document.createRange()
    range.selectNodeContents(p)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  })
  await expect(paragraph).toHaveCSS('text-indent', '0px')
  await expect(editor.getByRole('button', { name: /本段缩进/ })).toHaveCount(0)
  await visual.press('Tab')
  expect(await paragraph.textContent()).toMatch(/^\tTemperature:/)
  await visual.press('Backspace')
  await visual.press('Space')
  await visual.press('Space')
  expect((await paragraph.textContent())?.replaceAll('\u00a0', ' ')).toMatch(/^  Temperature:/)

  await editor.getByRole('radio', { name: '源码' }).click()
  expect(await source.inputValue()).toMatch(/\n  Temperature:/)
  await source.fill('顶格\n  两个空格\n\t一个制表符')
  await source.press('Control+Home')
  await source.press('Tab')
  await expect(source).toHaveValue('\t顶格\n  两个空格\n\t一个制表符')
  await source.press('Backspace')
  await editor.getByRole('radio', { name: '可视化' }).click()
  expect(await visual.locator('p').textContent()).toBe('顶格  两个空格\t一个制表符')
  await visual.focus()
  await editor.getByRole('radio', { name: '源码' }).click()
  await expect(source).toHaveValue('顶格\n  两个空格\n\t一个制表符')
  await editor.getByRole('radio', { name: 'TXT' }).click()
  await source.fill('<p><strong>Recovered</strong></p>')
  await editor.getByRole('radio', { name: '可视化' }).click()
  await editor.getByRole('button', { name: '恢复富文本' }).click()
  await expect(visual.locator('strong')).toHaveText('Recovered')
})

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
