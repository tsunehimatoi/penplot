# -*- coding: utf-8 -*-
"""Tests for rich text stationery (flow_text): MD/HTML/Word import, LaTeX, charts, line layout."""
import io
import json
import zipfile

from penplot.compose import flow_text_pages
from penplot.rich_text import (
    ChartBlock, HeadingBlock, InlineMath, ListBlock, MathBlock, PageBreakBlock,
    ParagraphBlock, TableBlock, parse_html, parse_markdown,
)


def test_parse_markdown_rich_features():
    md = """# 主标题

普通段落包含 **加粗**、*斜体*、<u>下划线</u>、~~删除线~~ 和行内公式 $E = mc^2$。

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

- 项目一
- 项目二

| 姓名 | 分数 |
| :--- | ---: |
| 张三 | 95 |
| 李四 | 88 |

```chart
{"type": "bar", "title": "销量", "x": ["Q1", "Q2"], "series": [{"name": "A", "data": [10, 20]}]}
```

===

第二页内容
"""
    blocks = parse_markdown(md)
    assert isinstance(blocks[0], HeadingBlock) and blocks[0].level == 1
    assert isinstance(blocks[1], ParagraphBlock)
    assert any(isinstance(r, InlineMath) and r.latex == 'E = mc^2' for r in blocks[1].runs)
    # Inline math with LaTeX backslashes must also parse cleanly
    inline_tex = parse_markdown('欧拉公式 $e^{i\\pi} + 1 = 0$ 与 $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$')
    assert any(isinstance(r, InlineMath) and r.latex == r'e^{i\pi} + 1 = 0' for r in inline_tex[0].runs)
    assert any(isinstance(r, InlineMath) and r.latex == r'\lim_{x \to 0} \frac{\sin x}{x} = 1' for r in inline_tex[0].runs)
    assert isinstance(blocks[2], MathBlock)
    assert isinstance(blocks[3], ListBlock) and len(blocks[3].items) == 2
    assert isinstance(blocks[4], TableBlock) and len(blocks[4].headers) == 2 and len(blocks[4].rows) == 2
    assert isinstance(blocks[5], ChartBlock) and blocks[5].spec['type'] == 'bar'
    assert isinstance(blocks[6], PageBreakBlock)
    assert isinstance(blocks[7], ParagraphBlock)


def test_parse_word_pasted_html():
    html_str = """
    <!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]-->
    <h2 style="text-align:center">实验报告</h2>
    <p class="MsoNormal"><b>加粗</b> <i>斜体</i> <u>下划线</u> $a^2+b^2=c^2$</p>
    <table><tr><th>指标</th><th>数值</th></tr><tr><td>均值</td><td>3.14</td></tr></table>
    """
    blocks = parse_html(html_str)
    assert isinstance(blocks[0], HeadingBlock) and blocks[0].level == 2 and blocks[0].align == 'C'
    assert isinstance(blocks[1], ParagraphBlock)
    assert any(isinstance(r, InlineMath) for r in blocks[1].runs)
    assert isinstance(blocks[2], TableBlock) and len(blocks[2].rows) == 1


def _make_sample_docx() -> bytes:
    doc_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
      <w:body>
        <w:p>
          <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
          <w:r><w:t>Word标题</w:t></w:r>
        </w:p>
        <w:p>
          <w:r><w:rPr><w:b/></w:rPr><w:t>粗体正文</w:t></w:r>
          <m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath>
        </w:p>
        <w:tbl>
          <w:tr>
            <w:tc><w:p><w:r><w:t>列1</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>列2</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>值1</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>值2</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl>
      </w:body>
    </w:document>'''
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr('word/document.xml', doc_xml.encode('utf-8'))
    return buf.getvalue()


def test_import_document_endpoint(client):
    docx_bytes = _make_sample_docx()
    r = client.post('/api/v1/import/document',
                    files={'file': ('demo.docx', docx_bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d['format'] == 'html'
    assert 'Word标题' in d['content']
    assert '<strong>粗体正文</strong>' in d['content']
    assert r'\frac{a}{b}' in d['content']
    assert '<table>' in d['content']

    r2 = client.post('/api/v1/import/document',
                     files={'file': ('notes.md', '# Hello\n\n$x^2$'.encode('utf-8'), 'text/markdown')})
    assert r2.status_code == 200
    assert r2.json()['format'] == 'markdown'


def test_rich_flow_text_layout_and_render(client):
    from penplot.gfont import GFont, Glyph
    from penplot.settings import Settings

    class FakeRes:
        def __init__(self):
            f = GFont()
            f.name = 'test'
            f.size = 100.0
            for ch in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=.%()[]{}':
                f.inline[ord(ch)] = Glyph(ch, [0.0, 0.0, 60.0, 80.0], [1, 2])
            self._f = f

        def font(self, fid):
            return self._f

    paper = {
        'width_mm': 210.0, 'height_mm': 297.0,
        'margins': {'l': 20.0, 'r': 20.0, 't': 20.0, 'b': 20.0},
        'orientation': 'portrait', 'rotation': 0.0,
        'ruling': {'line_num': 20, 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0},
    }
    md = """# Title

Paragraph with **bold**, *italic*, and inline math $x^2 + y^2$.

$$\\int_0^1 x^2 dx = \\frac{1}{3}$$

| ColA | ColB |
| --- | --- |
| 12 | 34 |

```chart
{"type": "line", "title": "Curve", "x": ["A", "B", "C"], "series": [{"name": "S1", "data": [1, 3, 2]}]}
```

```chart
{"type": "pie", "x": ["X", "Y"], "series": [{"data": [30, 70]}]}
```

```chart
{"type": "function", "expr": "sin(x)", "xmin": -3.14, "xmax": 3.14}
```
"""
    el = {
        'id': 'rich1',
        'type': 'flow_text',
        'props': {
            'text': md,
            'format': 'markdown',
            'rich_style': {'heading_scale': 1.4, 'chart_lines': 6, 'math_scale': 1.0},
            'text_size': 1.0,
            'char_space': 0.0,
            'align': 'L',
            'paragraph': {'spe_type': 0, 'spe_value': 0, 'left': 0, 'right': 0},
        },
    }
    warn = {'missing': set(), 'overflow': False, 'messages': []}
    pages = flow_text_pages(el, paper, FakeRes(), {}, Settings(), warn)
    assert len(pages) >= 2  # automatically paginated across pages
    assert all(len(p) > 0 for p in pages)
