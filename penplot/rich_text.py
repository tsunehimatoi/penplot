# -*- coding: utf-8 -*-
"""Rich text Intermediate Representation (IR) and Markdown / HTML parsers.

Used by the extended stationery (flow_text) layout engine to support Markdown,
HTML, Word-pasted HTML, LaTeX math ($...$ / $$...$$), tables, charts, and SVG.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Optional, Union


# ------------------------------------------------------------------ IR nodes

@dataclass
class TextRun:
    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False
    strike: bool = False
    code: bool = False
    sup: bool = False
    sub: bool = False


@dataclass
class InlineMath:
    latex: str


Inline = Union[TextRun, InlineMath]


@dataclass
class HeadingBlock:
    level: int
    runs: list[Inline]
    align: Optional[str] = None


@dataclass
class ParagraphBlock:
    runs: list[Inline]
    align: Optional[str] = None


@dataclass
class ListItem:
    runs: list[Inline]
    children: list['Block'] = field(default_factory=list)


@dataclass
class ListBlock:
    ordered: bool
    items: list[ListItem]
    start: int = 1


@dataclass
class QuoteBlock:
    blocks: list['Block']


@dataclass
class CodeBlock:
    code: str
    lang: str = ''


@dataclass
class MathBlock:
    latex: str


@dataclass
class ChartBlock:
    spec: dict[str, Any]


@dataclass
class SvgBlock:
    svg: str
    height_lines: Optional[float] = None


@dataclass
class TableBlock:
    headers: list[list[Inline]]
    rows: list[list[list[Inline]]]
    aligns: list[str] = field(default_factory=list)


@dataclass
class HrBlock:
    pass


@dataclass
class PageBreakBlock:
    pass


Block = Union[
    HeadingBlock, ParagraphBlock, ListBlock, QuoteBlock, CodeBlock,
    MathBlock, ChartBlock, SvgBlock, TableBlock, HrBlock, PageBreakBlock,
]


# ------------------------------------------------------------------ Chart spec parsing

def _parse_chart_spec(raw: str) -> Optional[dict[str, Any]]:
    """Parse JSON or simple key:value chart specification."""
    s = raw.strip()
    if not s:
        return None
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    # Fallback: simple line-based key: value format
    spec: dict[str, Any] = {}
    for line in s.splitlines():
        line = line.strip()
        if not line or line.startswith('#') or ':' not in line:
            continue
        k, v = line.split(':', 1)
        k = k.strip().lower()
        v = v.strip()
        try:
            spec[k] = json.loads(v)
        except Exception:
            spec[k] = v
    return spec if spec else None


# ------------------------------------------------------------------ Inline parser (Markdown + LaTeX)

_INLINE_TOKEN_RE = re.compile(
    r'(\\\((?:\\.|[^\\])+?\\\)'           # \( ... \)
    r'|\$(?!\s)(?:\\.|[^$\\])+?(?<!\s)\$'  # $ ... $
    r'|`[^`]+`'                            # `code`
    r'|\*\*(?=\S)(?:\\.|[^*])+?(?<=\S)\*\*' # **bold**
    r'|__(?=\S)(?:\\.|[^_])+?(?<=\S)__'    # __bold__
    r'|~~(?=\S)(?:\\.|[^~])+?(?<=\S)~~'    # ~~strike~~
    r'|\*(?=\S)(?:\\.|[^*])+?(?<=\S)\*'    # *italic*
    r'|_(?=\S)(?:\\.|[^_])+?(?<=\S)_'      # _italic_
    r'|!\[[^\]]*\]\([^)]+\)'               # ![alt](url)
    r'|\[([^\]]+)\]\([^)]+\)'              # [text](url)
    r'|<br\s*/?>'                          # <br>
    r'|<sup>(.*?)</sup>'                   # <sup>...</sup>
    r'|<sub>(.*?)</sub>'                   # <sub>...</sub>
    r'|<u>(.*?)</u>'                       # <u>...</u>
    r')',
    re.DOTALL | re.IGNORECASE,
)


def parse_inline(text: str, *, bold=False, italic=False, underline=False,
                 strike=False, code=False, sup=False, sub=False) -> list[Inline]:
    """Parse inline Markdown, inline HTML tags, and $...$ / \\(...\\) math."""
    if not text:
        return []
    out: list[Inline] = []
    pos = 0
    for m in _INLINE_TOKEN_RE.finditer(text):
        if m.start() > pos:
            plain = text[pos:m.start()]
            if plain:
                out.append(TextRun(plain, bold=bold, italic=italic, underline=underline,
                                   strike=strike, code=code, sup=sup, sub=sub))
        tok = m.group(0)
        low = tok.lower()
        if tok.startswith('\\(') and tok.endswith('\\)'):
            out.append(InlineMath(tok[2:-2].strip()))
        elif tok.startswith('$') and tok.endswith('$'):
            out.append(InlineMath(tok[1:-1].strip()))
        elif tok.startswith('`') and tok.endswith('`'):
            out.append(TextRun(tok[1:-1], bold=bold, italic=italic, underline=underline,
                               strike=strike, code=True, sup=sup, sub=sub))
        elif (tok.startswith('**') and tok.endswith('**')) or (tok.startswith('__') and tok.endswith('__')):
            out.extend(parse_inline(tok[2:-2], bold=True, italic=italic, underline=underline,
                                    strike=strike, code=code, sup=sup, sub=sub))
        elif tok.startswith('~~') and tok.endswith('~~'):
            out.extend(parse_inline(tok[2:-2], bold=bold, italic=italic, underline=underline,
                                    strike=True, code=code, sup=sup, sub=sub))
        elif (tok.startswith('*') and tok.endswith('*')) or (tok.startswith('_') and tok.endswith('_')):
            out.extend(parse_inline(tok[1:-1], bold=bold, italic=True, underline=underline,
                                    strike=strike, code=code, sup=sup, sub=sub))
        elif tok.startswith('!['):
            alt = tok[2:tok.index(']')]
            if alt:
                out.append(TextRun(f'[{alt}]', bold=bold, italic=italic, underline=underline,
                                   strike=strike, code=code, sup=sup, sub=sub))
        elif tok.startswith('['):
            label = m.group(2) or ''
            out.extend(parse_inline(label, bold=bold, italic=italic, underline=True,
                                    strike=strike, code=code, sup=sup, sub=sub))
        elif low.startswith('<br'):
            out.append(TextRun('\n', bold=bold, italic=italic, underline=underline,
                               strike=strike, code=code, sup=sup, sub=sub))
        elif low.startswith('<sup>'):
            out.extend(parse_inline(m.group(3) or '', bold=bold, italic=italic, underline=underline,
                                    strike=strike, code=code, sup=True, sub=sub))
        elif low.startswith('<sub>'):
            out.extend(parse_inline(m.group(4) or '', bold=bold, italic=italic, underline=underline,
                                    strike=strike, code=code, sup=sup, sub=True))
        elif low.startswith('<u>'):
            out.extend(parse_inline(m.group(5) or '', bold=bold, italic=italic, underline=True,
                                    strike=strike, code=code, sup=sup, sub=sub))
        pos = m.end()
    if pos < len(text):
        tail = text[pos:]
        if tail:
            out.append(TextRun(tail, bold=bold, italic=italic, underline=underline,
                               strike=strike, code=code, sup=sup, sub=sub))
    return out


# ------------------------------------------------------------------ Markdown parser

_HEADING_RE = re.compile(r'^(#{1,6})\s+(.*?)\s*#*\s*$')
_FENCE_RE = re.compile(r'^(`{3,}|~{3,})\s*([\w+-]*)\s*$')
_HR_RE = re.compile(r'^\s*(?:[-*_]\s*){3,}\s*$')
_PAGEBREAK_RE = re.compile(r'^\s*(?:={3,}|\\newpage|\\pagebreak|<!--\s*pagebreak\s*-->)\s*$', re.IGNORECASE)
_UL_RE = re.compile(r'^(\s*)[-*+]\s+(.*)$')
_OL_RE = re.compile(r'^(\s*)(\d+)[.)]\s+(.*)$')
_QUOTE_RE = re.compile(r'^\s*>\s?(.*)$')
_TABLE_SEP_RE = re.compile(r'^\s*\|?\s*(?::?-{2,}:?\s*\|\s*)*:?-+:?\s*\|?\s*$')


def _split_table_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|'):
        s = s[:-1]
    return [c.strip() for c in s.split('|')]


def _parse_table_aligns(sep_line: str, ncols: int) -> list[str]:
    cells = _split_table_row(sep_line)
    aligns = []
    for c in cells[:ncols]:
        c = c.strip()
        if c.startswith(':') and c.endswith(':'):
            aligns.append('C')
        elif c.endswith(':'):
            aligns.append('R')
        else:
            aligns.append('L')
    while len(aligns) < ncols:
        aligns.append('L')
    return aligns


def parse_markdown(text: str) -> list[Block]:
    """Parse Markdown (+ GFM tables, LaTeX math, ```chart, inline <svg>) into IR blocks."""
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    n = len(lines)
    i = 0
    blocks: list[Block] = []

    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # Page break
        if _PAGEBREAK_RE.match(line):
            blocks.append(PageBreakBlock())
            i += 1
            continue

        # Horizontal rule
        if _HR_RE.match(line):
            blocks.append(HrBlock())
            i += 1
            continue

        # Fenced code block (```chart, ```math, ```svg, ```lang)
        fm = _FENCE_RE.match(line)
        if fm:
            fence = fm.group(1)
            lang = fm.group(2).lower()
            i += 1
            body_lines = []
            while i < n and not lines[i].strip().startswith(fence):
                body_lines.append(lines[i])
                i += 1
            if i < n:
                i += 1
            body = '\n'.join(body_lines)
            if lang in ('chart', 'plot', 'echarts'):
                spec = _parse_chart_spec(body)
                if spec:
                    blocks.append(ChartBlock(spec))
                    continue
            if lang in ('math', 'latex', 'tex'):
                blocks.append(MathBlock(body.strip()))
                continue
            if lang == 'svg' and '<svg' in body.lower():
                blocks.append(SvgBlock(body))
                continue
            blocks.append(CodeBlock(body, lang))
            continue

        # Display math $$ ... $$ or \[ ... \]
        if stripped.startswith('$$'):
            if stripped.endswith('$$') and len(stripped) > 4:
                blocks.append(MathBlock(stripped[2:-2].strip()))
                i += 1
                continue
            i += 1
            mlines = [stripped[2:]] if len(stripped) > 2 else []
            while i < n:
                cur = lines[i]
                if cur.strip().endswith('$$'):
                    tail = cur.strip()[:-2]
                    if tail:
                        mlines.append(tail)
                    i += 1
                    break
                mlines.append(cur)
                i += 1
            blocks.append(MathBlock('\n'.join(mlines).strip()))
            continue

        if stripped.startswith('\\['):
            if stripped.endswith('\\]') and len(stripped) > 4:
                blocks.append(MathBlock(stripped[2:-2].strip()))
                i += 1
                continue
            i += 1
            mlines = [stripped[2:]] if len(stripped) > 2 else []
            while i < n:
                cur = lines[i]
                if cur.strip().endswith('\\]'):
                    tail = cur.strip()[:-2]
                    if tail:
                        mlines.append(tail)
                    i += 1
                    break
                mlines.append(cur)
                i += 1
            blocks.append(MathBlock('\n'.join(mlines).strip()))
            continue

        # Inline <svg> ... </svg>
        if stripped.lower().startswith('<svg'):
            svg_lines = [line]
            if '</svg>' not in stripped.lower():
                i += 1
                while i < n:
                    svg_lines.append(lines[i])
                    if '</svg>' in lines[i].lower():
                        i += 1
                        break
                    i += 1
            else:
                i += 1
            blocks.append(SvgBlock('\n'.join(svg_lines)))
            continue

        # Inline HTML <table> ... </table>
        if stripped.lower().startswith('<table'):
            tbl_lines = [line]
            if '</table>' not in stripped.lower():
                i += 1
                while i < n:
                    tbl_lines.append(lines[i])
                    if '</table>' in lines[i].lower():
                        i += 1
                        break
                    i += 1
            else:
                i += 1
            blocks.extend(parse_html('\n'.join(tbl_lines)))
            continue

        # Heading
        hm = _HEADING_RE.match(line)
        if hm:
            blocks.append(HeadingBlock(len(hm.group(1)), parse_inline(hm.group(2))))
            i += 1
            continue

        # GFM Table
        if '|' in line and i + 1 < n and _TABLE_SEP_RE.match(lines[i + 1]):
            headers = [parse_inline(c) for c in _split_table_row(line)]
            aligns = _parse_table_aligns(lines[i + 1], len(headers))
            i += 2
            rows: list[list[list[Inline]]] = []
            while i < n and lines[i].strip() and '|' in lines[i]:
                cells = _split_table_row(lines[i])
                while len(cells) < len(headers):
                    cells.append('')
                rows.append([parse_inline(c) for c in cells[:len(headers)]])
                i += 1
            blocks.append(TableBlock(headers=headers, rows=rows, aligns=aligns))
            continue

        # Blockquote
        if _QUOTE_RE.match(line):
            qlines = []
            while i < n and _QUOTE_RE.match(lines[i]):
                qlines.append(_QUOTE_RE.match(lines[i]).group(1))
                i += 1
            blocks.append(QuoteBlock(parse_markdown('\n'.join(qlines))))
            continue

        # List (unordered or ordered)
        um = _UL_RE.match(line)
        om = _OL_RE.match(line)
        if um or om:
            ordered = bool(om)
            base_indent = len((om or um).group(1))
            start = int(om.group(2)) if om else 1
            items: list[ListItem] = []
            while i < n:
                cur_line = lines[i]
                if not cur_line.strip():
                    break
                cur_u = _UL_RE.match(cur_line)
                cur_o = _OL_RE.match(cur_line)
                m_cur = cur_o if ordered else cur_u
                if m_cur and len(m_cur.group(1)) == base_indent:
                    txt = m_cur.group(3) if ordered else m_cur.group(2)
                    items.append(ListItem(parse_inline(txt)))
                    i += 1
                elif (cur_u or cur_o) and len((cur_u or cur_o).group(1)) > base_indent:
                    sub_indent = len((cur_u or cur_o).group(1))
                    sub_lines = []
                    while i < n and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) >= sub_indent):
                        sub_lines.append(lines[i][sub_indent:] if len(lines[i]) >= sub_indent else lines[i])
                        i += 1
                    if items:
                        items[-1].children.extend(parse_markdown('\n'.join(sub_lines)))
                else:
                    break
            blocks.append(ListBlock(ordered=ordered, items=items, start=start))
            continue

        # Paragraph (collect consecutive non-empty plain lines)
        plines = []
        while i < n:
            cur = lines[i]
            cs = cur.strip()
            if (not cs or _HEADING_RE.match(cur) or _FENCE_RE.match(cur) or _HR_RE.match(cur)
                    or _PAGEBREAK_RE.match(cur) or _QUOTE_RE.match(cur) or _UL_RE.match(cur)
                    or _OL_RE.match(cur) or cs.startswith('$$') or cs.startswith('\\[')
                    or cs.lower().startswith('<svg') or cs.lower().startswith('<table')):
                break
            if '|' in cur and i + 1 < n and _TABLE_SEP_RE.match(lines[i + 1]):
                break
            plines.append(cur)
            i += 1
        para_text = ' '.join(l.strip() for l in plines)
        blocks.append(ParagraphBlock(parse_inline(para_text)))

    return blocks


# ------------------------------------------------------------------ HTML parser

_SKIP_TAGS = {'script', 'style', 'head', 'meta', 'link', 'title', 'noscript', 'xml'}
_VOID_TAGS = {'br', 'hr', 'img', 'input', 'meta', 'link', 'col'}


def _parse_align_attr(attrs: dict[str, str]) -> Optional[str]:
    align = (attrs.get('align') or '').lower()
    style = (attrs.get('style') or '').lower()
    m = re.search(r'text-align\s*:\s*(left|center|right|justify)', style)
    if m:
        align = m.group(1)
    return {'left': 'L', 'center': 'C', 'right': 'R', 'justify': 'D'}.get(align)


def _has_page_break(attrs: dict[str, str]) -> bool:
    style = (attrs.get('style') or '').lower()
    cls = (attrs.get('class') or '').lower()
    return ('page-break-before' in style and 'always' in style) or \
           ('page-break-after' in style and 'always' in style) or \
           'pagebreak' in cls


class _RichHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self.skip_depth = 0
        self.in_svg = 0
        self.svg_buf: list[str] = []
        self.style_stack: list[dict[str, bool]] = [{}]
        self.runs: list[Inline] = []
        self.cur_align: Optional[str] = None
        self.heading_level: int = 0
        self.in_pre = False
        self.pre_lang = ''
        self.pre_buf: list[str] = []
        self.quote_stack: list[list[Block]] = []
        self.list_stack: list[tuple[bool, list[ListItem]]] = []
        self.table_stack: list[dict[str, Any]] = []
        self.math_mode: Optional[str] = None
        self.math_buf: list[str] = []

    def _cur_style(self) -> dict[str, bool]:
        s = {'bold': False, 'italic': False, 'underline': False, 'strike': False,
             'code': False, 'sup': False, 'sub': False}
        for d in self.style_stack:
            s.update(d)
        return s

    def _target_blocks(self) -> list[Block]:
        if self.quote_stack:
            return self.quote_stack[-1]
        return self.blocks

    def _flush_runs(self, as_paragraph=True):
        if not self.runs:
            return
        # Trim leading/trailing pure whitespace if empty
        if all(isinstance(r, TextRun) and not r.text.strip() for r in self.runs):
            self.runs.clear()
            return
        # Split inline math / text into runs (also handle $...$ inside text runs)
        final_runs: list[Inline] = []
        for r in self.runs:
            if isinstance(r, TextRun) and ('$' in r.text or '\\(' in r.text):
                final_runs.extend(parse_inline(
                    r.text, bold=r.bold, italic=r.italic, underline=r.underline,
                    strike=r.strike, code=r.code, sup=r.sup, sub=r.sub,
                ))
            else:
                final_runs.append(r)
        self.runs.clear()

        if self.table_stack:
            tbl = self.table_stack[-1]
            if tbl['in_cell'] is not None:
                tbl['in_cell'].extend(final_runs)
                return
        if self.list_stack and not self.heading_level:
            _, items = self.list_stack[-1]
            if items:
                items[-1].runs.extend(final_runs)
                return
        if self.heading_level:
            self._target_blocks().append(HeadingBlock(self.heading_level, final_runs, self.cur_align))
        elif as_paragraph:
            self._target_blocks().append(ParagraphBlock(final_runs, self.cur_align))

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, Optional[str]]]):
        tag = tag.lower()
        attrs = {k.lower(): (v or '') for k, v in attrs_list}

        if self.in_svg:
            self.in_svg += 1
            attr_s = ''.join(f' {k}="{v}"' for k, v in attrs_list)
            self.svg_buf.append(f'<{tag}{attr_s}>')
            return

        if tag == 'svg':
            self._flush_runs()
            self.in_svg = 1
            attr_s = ''.join(f' {k}="{v}"' for k, v in attrs_list)
            self.svg_buf = [f'<svg{attr_s}>']
            return

        if tag in _SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return

        if _has_page_break(attrs):
            self._flush_runs()
            self._target_blocks().append(PageBreakBlock())

        # Chart container
        if 'data-chart' in attrs and attrs['data-chart']:
            self._flush_runs()
            spec = _parse_chart_spec(attrs['data-chart'])
            if spec:
                self._target_blocks().append(ChartBlock(spec))
            return

        # Math container
        cls = attrs.get('class', '').lower()
        if 'math-display' in cls or tag == 'math':
            self._flush_runs()
            self.math_mode = 'block'
            self.math_buf = []
            return
        if 'math-inline' in cls:
            self.math_mode = 'inline'
            self.math_buf = []
            return

        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._flush_runs()
            self.heading_level = int(tag[1])
            self.cur_align = _parse_align_attr(attrs)
        elif tag in ('p', 'div'):
            self._flush_runs()
            self.cur_align = _parse_align_attr(attrs)
        elif tag == 'br':
            self.runs.append(TextRun('\n', **self._cur_style()))
        elif tag == 'hr':
            self._flush_runs()
            self._target_blocks().append(HrBlock())
        elif tag == 'blockquote':
            self._flush_runs()
            self.quote_stack.append([])
        elif tag == 'pre':
            self._flush_runs()
            self.in_pre = True
            self.pre_lang = ''
            self.pre_buf = []
        elif tag == 'code':
            if self.in_pre:
                m = re.search(r'language-([\w+-]+)', cls)
                if m:
                    self.pre_lang = m.group(1).lower()
            else:
                self.style_stack.append({'code': True})
        elif tag in ('ul', 'ol'):
            self._flush_runs()
            self.list_stack.append((tag == 'ol', []))
        elif tag == 'li':
            if self.list_stack:
                self._flush_runs()
                self.list_stack[-1][1].append(ListItem([]))
        elif tag == 'table':
            self._flush_runs()
            self.table_stack.append({'headers': [], 'rows': [], 'cur_row': None, 'in_cell': None, 'is_header_row': False})
        elif tag == 'tr' and self.table_stack:
            self.table_stack[-1]['cur_row'] = []
            self.table_stack[-1]['is_header_row'] = False
        elif tag in ('th', 'td') and self.table_stack:
            tbl = self.table_stack[-1]
            if tag == 'th':
                tbl['is_header_row'] = True
            tbl['in_cell'] = []
        elif tag in ('b', 'strong'):
            self.style_stack.append({'bold': True})
        elif tag in ('i', 'em'):
            self.style_stack.append({'italic': True})
        elif tag in ('u', 'ins'):
            self.style_stack.append({'underline': True})
        elif tag in ('s', 'del', 'strike'):
            self.style_stack.append({'strike': True})
        elif tag == 'sup':
            self.style_stack.append({'sup': True})
        elif tag == 'sub':
            self.style_stack.append({'sub': True})
        elif tag == 'a':
            self.style_stack.append({'underline': True})
        elif tag == 'img':
            src = attrs.get('src', '')
            alt = attrs.get('alt', '')
            if src.startswith('data:image/svg+xml'):
                self._flush_runs()
                # Decode data URI svg
                import base64
                import urllib.parse
                if ';base64,' in src:
                    raw_svg = base64.b64decode(src.split(';base64,', 1)[1]).decode('utf-8', errors='replace')
                elif ',' in src:
                    raw_svg = urllib.parse.unquote(src.split(',', 1)[1])
                else:
                    raw_svg = ''
                if '<svg' in raw_svg.lower():
                    self._target_blocks().append(SvgBlock(raw_svg))
            elif alt:
                self.runs.append(TextRun(f'[{alt}]', **self._cur_style()))

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if self.in_svg:
            self.svg_buf.append(f'</{tag}>')
            self.in_svg -= 1
            if self.in_svg == 0:
                self._target_blocks().append(SvgBlock(''.join(self.svg_buf)))
                self.svg_buf = []
            return
        if tag in _SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if self.math_mode and (tag in ('span', 'div', 'math')):
            latex = ''.join(self.math_buf).strip().strip('$')
            if self.math_mode == 'block':
                self._target_blocks().append(MathBlock(latex))
            else:
                self.runs.append(InlineMath(latex))
            self.math_mode = None
            self.math_buf = []
            return

        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._flush_runs()
            self.heading_level = 0
            self.cur_align = None
        elif tag in ('p', 'div'):
            self._flush_runs()
            self.cur_align = None
        elif tag == 'blockquote' and self.quote_stack:
            self._flush_runs()
            qblocks = self.quote_stack.pop()
            self._target_blocks().append(QuoteBlock(qblocks))
        elif tag == 'pre' and self.in_pre:
            self.in_pre = False
            code = ''.join(self.pre_buf).strip('\n')
            self.pre_buf = []
            if self.pre_lang in ('chart', 'plot', 'echarts'):
                spec = _parse_chart_spec(code)
                if spec:
                    self._target_blocks().append(ChartBlock(spec))
                    return
            if self.pre_lang in ('math', 'latex', 'tex'):
                self._target_blocks().append(MathBlock(code))
                return
            self._target_blocks().append(CodeBlock(code, self.pre_lang))
        elif tag == 'code' and not self.in_pre:
            if len(self.style_stack) > 1:
                self.style_stack.pop()
        elif tag in ('ul', 'ol') and self.list_stack:
            self._flush_runs()
            ordered, items = self.list_stack.pop()
            if self.list_stack and self.list_stack[-1][1]:
                self.list_stack[-1][1][-1].children.append(ListBlock(ordered=ordered, items=items))
            else:
                self._target_blocks().append(ListBlock(ordered=ordered, items=items))
        elif tag == 'li':
            self._flush_runs()
        elif tag in ('th', 'td') and self.table_stack:
            tbl = self.table_stack[-1]
            self._flush_runs()
            if tbl['cur_row'] is not None and tbl['in_cell'] is not None:
                tbl['cur_row'].append(tbl['in_cell'])
            tbl['in_cell'] = None
        elif tag == 'tr' and self.table_stack:
            tbl = self.table_stack[-1]
            row = tbl['cur_row']
            tbl['cur_row'] = None
            if row is not None:
                if tbl['is_header_row'] and not tbl['headers']:
                    tbl['headers'] = row
                else:
                    tbl['rows'].append(row)
        elif tag == 'table' and self.table_stack:
            tbl = self.table_stack.pop()
            headers = tbl['headers']
            rows = tbl['rows']
            if not headers and rows:
                headers = rows[0]
                rows = rows[1:]
            ncols = max([len(headers)] + [len(r) for r in rows] + [0])
            if ncols > 0:
                while len(headers) < ncols:
                    headers.append([])
                for r in rows:
                    while len(r) < ncols:
                        r.append([])
                self._target_blocks().append(TableBlock(headers=headers, rows=rows, aligns=['L'] * ncols))
        elif tag in ('b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'strike', 'sup', 'sub', 'a'):
            if len(self.style_stack) > 1:
                self.style_stack.pop()

    def handle_data(self, data: str):
        if self.in_svg:
            self.svg_buf.append(data)
            return
        if self.skip_depth:
            return
        if self.math_mode:
            self.math_buf.append(data)
            return
        if self.in_pre:
            self.pre_buf.append(data)
            return
        # Collapse HTML whitespace outside <pre>
        collapsed = re.sub(r'[ \t\r\n]+', ' ', data)
        if not collapsed:
            return
        # Check for block-level $$...$$ inside text
        if '$$' in collapsed or '\\[' in collapsed:
            parts = re.split(r'(\$\$.*?\$\$|\\\[.*?\\\])', collapsed, flags=re.DOTALL)
            for pt in parts:
                if not pt:
                    continue
                if (pt.startswith('$$') and pt.endswith('$$')) or (pt.startswith('\\[') and pt.endswith('\\]')):
                    self._flush_runs()
                    self._target_blocks().append(MathBlock(pt[2:-2].strip()))
                else:
                    self.runs.append(TextRun(pt, **self._cur_style()))
            return
        self.runs.append(TextRun(collapsed, **self._cur_style()))


def parse_html(html_str: str) -> list[Block]:
    """Parse HTML (including Word-pasted HTML) into rich text IR blocks."""
    # Strip Word conditional comments <!--[if ...]>...<![endif]-->
    cleaned = re.sub(r'<!--\[if[^\]]*\]>.*?<!\[endif\]-->', '', html_str, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r'<!--.*?-->', '', cleaned, flags=re.DOTALL)
    parser = _RichHTMLParser()
    parser.feed(cleaned)
    parser.close()
    parser._flush_runs()
    return parser.blocks


def parse_rich(content: str, fmt: str = 'markdown') -> list[Block]:
    """Parse rich content ('markdown', 'html', or 'plain') into IR blocks."""
    if fmt == 'html':
        return parse_html(content)
    if fmt == 'markdown':
        return parse_markdown(content)
    return [ParagraphBlock([TextRun(line)]) for line in content.replace('\r\n', '\n').split('\n')]
