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


def _make_fake_res(ascender=False):
    from penplot.gfont import GFont, Glyph

    class FakeRes:
        def __init__(self):
            f = GFont()
            f.name = 'test'
            f.size = 100.0
            coords = [0.0, 0.0, 60.0, -70.0] if ascender else [0.0, 0.0, 60.0, 80.0]
            for ch in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-=.%()[]{}':
                f.inline[ord(ch)] = Glyph(ch, coords, [1, 2])
            self._f = f

        def font(self, fid):
            return self._f

    return FakeRes()


def test_rich_flow_text_layout_and_render(client):
    from penplot.settings import Settings

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
    pages = flow_text_pages(el, paper, _make_fake_res(), {}, Settings(), warn)
    assert len(pages) >= 2  # automatically paginated across pages
    assert all(len(p) > 0 for p in pages)


def test_bare_scripts_sup_sub():
    from penplot.rich_text import TextRun, parse_inline

    runs = parse_inline('E = mc^2 与 a^2 + b^{n+1} 和 H_2O, a_1 + b_2, snake_case_var')
    sups = [r.text for r in runs if isinstance(r, TextRun) and r.sup]
    subs = [r.text for r in runs if isinstance(r, TextRun) and r.sub]
    assert sups == ['2', '2', 'n+1']
    assert subs == ['2', '1', '2']
    assert any(isinstance(r, TextRun) and 'snake_case_var' in r.text for r in runs)


def test_paper_layout_boxes_schema_and_backward_compat(client):
    import pytest
    from pydantic import ValidationError
    from penplot.web.schemas.projects import LayoutBox, PaperBase

    legacy = PaperBase(name='legacy', width_mm=210, height_mm=297)
    assert legacy.layout_boxes == []

    box = LayoutBox(id='b1', name='左栏', x_mm=15, y_mm=20, w_mm=80, h_mm=200)
    assert box.line_num is None
    paper = PaperBase(name='two-col', width_mm=210, height_mm=297, layout_boxes=[box])
    assert len(paper.layout_boxes) == 1
    assert paper.layout_boxes[0].w_mm == 80

    with pytest.raises(ValidationError):
        LayoutBox(x_mm=10, y_mm=10, w_mm=0, h_mm=50)
    with pytest.raises(ValidationError):
        LayoutBox(x_mm=10, y_mm=10, w_mm=50, h_mm=50, line_num=0)

    # Builtin papers remain backward-compatible and custom paper persists layout_boxes via API
    r_list = client.get('/api/v1/papers')
    assert r_list.status_code == 200
    assert all(p['layout_boxes'] == [] for p in r_list.json())

    r_create = client.post('/api/v1/papers', json={
        'name': '双栏测试纸',
        'width_mm': 210,
        'height_mm': 297,
        'layout_boxes': [
            {'id': 'b1', 'x_mm': 15, 'y_mm': 20, 'w_mm': 85, 'h_mm': 250},
            {'id': 'b2', 'x_mm': 110, 'y_mm': 20, 'w_mm': 85, 'h_mm': 250},
        ],
    })
    assert r_create.status_code == 201, r_create.text
    created = r_create.json()
    assert len(created['layout_boxes']) == 2 and created['layout_boxes'][0]['id'] == 'b1'
    assert client.delete(f"/api/v1/papers/{created['id']}").status_code == 204


def test_html_blank_lines_containers_pagebreaks_and_alignment():
    from penplot.geometry import bbox_of
    from penplot.settings import Settings

    html = (
        '<p style="text-align:center">Top</p>'
        '<p><br></p>'
        '<p></p>'
        '<p>&nbsp;</p>'
        '<div><br></div>'
        '<div class="wrapper"><p>hi</p></div>'
        '<div style="text-align:right"><p>aligned</p></div>'
        '<div style="page-break-after: always" data-pagebreak="true"></div>'
        '<div style="page-break-after: always"><br></div>'
        '<h3 style="text-align:center">End</h3>'
    )
    blocks = parse_html(html)
    assert len(blocks) == 10
    assert isinstance(blocks[0], ParagraphBlock) and blocks[0].align == 'C'
    for idx in (1, 2, 3, 4):
        assert isinstance(blocks[idx], ParagraphBlock) and blocks[idx].runs == []
    assert isinstance(blocks[5], ParagraphBlock) and len(blocks[5].runs) == 1
    assert blocks[5].runs[0].text == 'hi'
    assert isinstance(blocks[6], ParagraphBlock) and blocks[6].align == 'R'
    assert isinstance(blocks[7], PageBreakBlock)
    assert isinstance(blocks[8], PageBreakBlock)
    assert isinstance(blocks[9], HeadingBlock) and blocks[9].level == 3 and blocks[9].align == 'C'

    # Render test: blank line genuinely advances one full line_h, and text-align:center centers on page
    paper = {
        'width_mm': 120.0, 'height_mm': 120.0,
        'margins': {'l': 10.0, 'r': 10.0, 't': 10.0, 'b': 10.0},
        'orientation': 'portrait', 'rotation': 0.0,
        'ruling': {'line_num': 10, 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0},
    }
    el = {
        'id': 'blank-align',
        'type': 'flow_text',
        'props': {
            'text': '<p style="text-align:center">A</p><p><br></p><p>B</p>',
            'format': 'html',
            'seed': 1,
        },
    }
    warn = {'missing': set(), 'overflow': False, 'messages': []}
    pages = flow_text_pages(el, paper, _make_fake_res(), {}, Settings(), warn)
    assert len(pages) == 1 and len(pages[0]) == 2
    bb_a = bbox_of([pages[0][0]])
    bb_b = bbox_of([pages[0][1]])
    # A is centered around x=60 (10 + 100/2), while B is left-aligned near x=10
    assert (bb_a[0] + bb_a[2]) / 2 > 45.0
    assert bb_b[0] < 20.0
    # One blank line between A (line 0) and B (line 2) -> dy == 2 * line_h (2 * 10mm = 20mm)
    assert abs((bb_b[1] - bb_a[1]) - 20.0) < 0.01

    # Centered & right-aligned paragraphs ignore first-line / hanging indent (spe_type 1/2)
    el_indented_center = {
        'id': 'center-with-indent',
        'type': 'flow_text',
        'props': {
            'text': '<p style="text-align:center">AB</p><p style="text-align:right">CD</p><p>EF</p>',
            'format': 'html',
            'paragraph': {'spe_type': 1, 'spe_value': 8.0, 'left': 0.0, 'right': 0.0},
            'seed': 1,
        },
    }
    pages_ic = flow_text_pages(el_indented_center, paper, _make_fake_res(ascender=True), {}, Settings(), warn)
    assert len(pages_ic) == 1 and len(pages_ic[0]) == 6
    bb_center = bbox_of(pages_ic[0][0:2])
    bb_right = bbox_of(pages_ic[0][2:4])
    bb_left = bbox_of(pages_ic[0][4:6])
    # Paper width 120, margins l=10, r=10 -> box center is 60.0, box right edge is 110.0
    assert abs((bb_center[0] + bb_center[2]) / 2.0 - 60.0) < 1.5
    assert abs(bb_right[2] - 110.0) < 1.5
    # Left-aligned paragraph still honors spe_type=1 indent (10 + 8 = 18.0)
    assert bb_left[0] >= 17.9


def test_flow_prefix_and_blank_continuation_match_print():
    from penplot.compose import Resolver, compose_pages, encode_paths, render_document
    from penplot.settings import MachineConfig

    paper = {
        'width_mm': 150.0, 'height_mm': 80.0,
        'margins': {'l': 0, 'r': 0, 't': 0, 'b': 0},
        'ruling': {'line_num': 10},
    }
    props = {
        'text': 'AA\nB', 'format': 'plain', 'line_num': 2, 'text_size': 0.45, 'seed': 42,
        'jitter': {'randomFirstPos': 2, 'randomFontSize': [0.8, 1.2], 'randomY': 0.03},
    }
    el = {'id': 'letter', 'type': 'flow_text', 'props': props}
    doc = {'pages': [{'elements': [el]}]}
    res = Resolver()
    mc = MachineConfig()
    original = compose_pages(doc, [paper], res, mc)
    assert len(original) == 1

    props.update(text='<p>AA</p><p>BC</p><p><br></p>', format='html')
    preview = compose_pages(doc, [paper], res, mc)
    assert len(preview) == 2
    assert encode_paths(preview[0][2][:len(original[0][2])]) == encode_paths(original[0][2])
    assert preview[1][2] == []

    props['text'] = '<p>AA</p><p>BC</p><p>D</p>'
    preview = compose_pages(doc, [paper], res, mc)
    rendered = render_document(doc, [paper], res, mc, opts={'optimize': False})
    assert len(rendered) == 2
    assert preview[1][2]
    assert [encode_paths(p.page_paths) for p in rendered] == [encode_paths(p[2]) for p in preview]


def test_multibox_flow_same_page_then_expand_pages():
    from penplot.geometry import bbox_of
    from penplot.settings import Settings

    # 2x2 grid on 210x297 paper, margins 20 -> margin_body_h = 257 -> base line_num=20 -> base line_h=12.85
    # Each box has h_mm = 64.25 (~5 lines) and explicit line_num=2 for easy exact boundary check
    boxes = [
        {'id': 'b1', 'x_mm': 10.0, 'y_mm': 10.0, 'w_mm': 80.0, 'h_mm': 20.0, 'line_num': 2},
        {'id': 'b2', 'x_mm': 110.0, 'y_mm': 10.0, 'w_mm': 80.0, 'h_mm': 20.0, 'line_num': 2},
        {'id': 'b3', 'x_mm': 10.0, 'y_mm': 50.0, 'w_mm': 80.0, 'h_mm': 20.0, 'line_num': 2},
        {'id': 'b4', 'x_mm': 110.0, 'y_mm': 50.0, 'w_mm': 80.0, 'h_mm': 20.0, 'line_num': 2},
    ]
    paper = {
        'width_mm': 210.0, 'height_mm': 297.0,
        'margins': {'l': 20.0, 'r': 20.0, 't': 20.0, 'b': 20.0},
        'orientation': 'portrait', 'rotation': 0.0,
        'ruling': {'line_num': 20, 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0},
        'layout_boxes': boxes,
    }
    # 9 paragraphs -> 8 fit across boxes 1..4 on page 1, 9th flows into box 1 on page 2
    html = ''.join(f'<p>L{i}</p>' for i in range(9))
    el = {'id': 'grid4', 'type': 'flow_text', 'props': {'text': html, 'format': 'html', 'seed': 1}}
    warn = {'missing': set(), 'overflow': False, 'messages': []}
    res = _make_fake_res(ascender=True)
    pages = flow_text_pages(el, paper, res, {}, Settings(), warn)
    assert len(pages) == 2

    # Page 1 paths should hit all 4 boxes (2 lines * 2 chars = 4 strokes per box -> 16 strokes)
    assert len(pages[0]) == 16
    p1_b1 = bbox_of(pages[0][0:4])
    p1_b2 = bbox_of(pages[0][4:8])
    p1_b3 = bbox_of(pages[0][8:12])
    p1_b4 = bbox_of(pages[0][12:16])
    assert 10.0 <= p1_b1[0] and p1_b1[2] <= 90.0 and 10.0 <= p1_b1[1] and p1_b1[3] <= 30.0
    assert 110.0 <= p1_b2[0] and p1_b2[2] <= 190.0 and 10.0 <= p1_b2[1] and p1_b2[3] <= 30.0
    assert 10.0 <= p1_b3[0] and p1_b3[2] <= 90.0 and 50.0 <= p1_b3[1] and p1_b3[3] <= 70.0
    assert 110.0 <= p1_b4[0] and p1_b4[2] <= 190.0 and 50.0 <= p1_b4[1] and p1_b4[3] <= 70.0

    # Page 2 reuses exact same coordinates starting at box 1 (10, 10)
    assert len(pages[1]) == 2
    p2_b1 = bbox_of(pages[1])
    assert 10.0 <= p2_b1[0] and p2_b1[2] <= 90.0 and 10.0 <= p2_b1[1] and p2_b1[3] <= 30.0

    # PageBreakBlock inside multi-box layout forces a new physical page (page 2 box 1)
    el_pb = {
        'id': 'pb-multi',
        'type': 'flow_text',
        'props': {
            'text': '<p>A</p><div style="page-break-after: always" data-pagebreak="true"></div><p>B</p>',
            'format': 'html',
            'seed': 1,
        },
    }
    pages_pb = flow_text_pages(el_pb, paper, res, {}, Settings(), warn)
    assert len(pages_pb) == 2
    assert bbox_of(pages_pb[1])[0] < 90.0 and bbox_of(pages_pb[1])[1] < 30.0


def test_multibox_variable_width_plain_auto_linenum_and_anchor_bbox():
    from penplot.compose import render_document
    from penplot.geometry import bbox_of
    from penplot.settings import MachineConfig, Settings

    # Box 1 is wide (120mm, 1 line), Box 2 is narrow (35mm, 6 lines).
    # Box 2 omits line_num to verify auto line_num keeps consistent line height.
    boxes = [
        {'id': 'wide', 'x_mm': 10.0, 'y_mm': 10.0, 'w_mm': 120.0, 'h_mm': 10.0, 'line_num': 1},
        {'id': 'narrow', 'x_mm': 140.0, 'y_mm': 20.0, 'w_mm': 35.0, 'h_mm': 60.0},
        {'id': 'quote_box', 'x_mm': 140.0, 'y_mm': 90.0, 'w_mm': 50.0, 'h_mm': 20.0, 'line_num': 2},
    ]
    paper = {
        'width_mm': 210.0, 'height_mm': 297.0,
        'margins': {'l': 10.0, 'r': 10.0, 't': 10.0, 'b': 10.0},
        'orientation': 'portrait', 'rotation': 0.0,
        # margin_body_h = 277, base line_num = 28 -> narrow box round(28 * 60 / 277) = 6 lines
        'ruling': {'line_num': 28, 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0},
        'layout_boxes': boxes,
    }
    res = _make_fake_res(ascender=True)
    # Long plain text must flow from wide box 1 into narrow box 2 without overflowing x > 140 + 35 = 175
    long_plain = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    el_plain = {
        'id': 'plain-varw',
        'type': 'flow_text',
        'props': {'text': long_plain, 'format': 'plain', 'seed': 1},
    }
    warn = {'missing': set(), 'overflow': False, 'messages': []}
    pages_plain = flow_text_pages(el_plain, paper, res, {}, Settings(), warn)
    assert len(pages_plain) == 1
    in_narrow = [p for p in pages_plain[0] if bbox_of([p])[0] >= 139.0]
    assert len(in_narrow) > 0
    narrow_bb = bbox_of(in_narrow)
    assert narrow_bb[0] >= 140.0 and narrow_bb[2] <= 175.0 + 1.0

    # Quote bar in a subsequent box must use that box's left_mm (not box 1's left_mm=10)
    # Fill box 1 (1 line) + box 2 (6 lines) = 7 lines, so > Q lands in box 3 (x=140)
    pages_q = flow_text_pages(
        {
            'id': 'quote-multi',
            'type': 'flow_text',
            'props': {
                'text': '<p>1</p><p>2</p><p>3</p><p>4</p><p>5</p><p>6</p><p>7</p><blockquote><p>Q</p></blockquote>',
                'format': 'html',
                'seed': 1,
            },
        },
        paper, res, {}, Settings(), warn,
    )
    assert len(pages_q) == 1
    # Quote bar + Q are in box 3 (y >= 90, x >= 140)
    in_box3 = [p for p in pages_q[0] if bbox_of([p])[1] >= 89.0]
    assert len(in_box3) >= 2
    assert bbox_of(in_box3)[0] >= 140.0

    # List & heading continuing across wide box 1 -> narrow box 2 must not overflow box 2
    for tag in ('<ul><li>ABCDEFGHIJKLMNOPQRSTUVWXYZ</li></ul>', '<h4>ABCDEFGHIJKLMNOPQRSTUVWXYZ</h4>'):
        pages_lh = flow_text_pages(
            {
                'id': 'lh-varw-' + tag[:2],
                'type': 'flow_text',
                'props': {'text': tag, 'format': 'html', 'seed': 1},
            },
            paper, res, {}, Settings(), warn,
        )
        assert len(pages_lh) == 1
        in_narrow_lh = [p for p in pages_lh[0] if bbox_of([p])[0] >= 139.0]
        assert len(in_narrow_lh) > 0
        assert bbox_of(in_narrow_lh)[2] <= 175.0 + 1.0

    # render_document with anchor='content' computes anchor_bbox as union of layout_boxes
    doc = {'pages': [{'elements': [el_plain]}]}
    mc = MachineConfig(machine_type='Grbl')
    rendered = render_document(doc, [paper], res, mc,
                               origin={'anchor': 'content', 'corner': 0}, opts={'optimize': False})
    assert len(rendered) == 1
    assert list(rendered[0].origin['anchor_bbox']) == [10.0, 10.0, 190.0, 110.0]
