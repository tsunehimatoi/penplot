# -*- coding: utf-8 -*-
"""Import rich documents (.md, .html, .docx, .txt) for stationery (flow_text)."""
from __future__ import annotations

import html
import io
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Any

from .table import decode_text

_W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
_M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
_C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

_W = f'{{{_W_NS}}}'
_M = f'{{{_M_NS}}}'
_C = f'{{{_C_NS}}}'


def _local(tag: str) -> str:
    return tag.split('}', 1)[-1] if '}' in tag else tag


# ------------------------------------------------------------------ OMML -> LaTeX

def _omml_to_latex(el: ET.Element) -> str:
    """Best-effort Office MathML (m:oMath) to LaTeX converter."""
    tag = _local(el.tag)
    if tag in ('oMath', 'oMathPara', 'e', 'num', 'den', 'sub', 'sup', 'deg', 'lim'):
        return ''.join(_omml_to_latex(c) for c in el)
    if tag == 'r':
        txt = ''.join(c.text or '' for c in el.iter() if _local(c.tag) == 't')
        return txt
    if tag == 't':
        return el.text or ''
    if tag == 'f':  # fraction
        num = el.find(f'{_M}num')
        den = el.find(f'{_M}den')
        n_s = _omml_to_latex(num) if num is not None else ''
        d_s = _omml_to_latex(den) if den is not None else ''
        return f'\\frac{{{n_s}}}{{{d_s}}}'
    if tag == 'sSup':
        base = el.find(f'{_M}e')
        sup = el.find(f'{_M}sup')
        return f'{_omml_to_latex(base) if base is not None else ""}^{{{_omml_to_latex(sup) if sup is not None else ""}}}'
    if tag == 'sSub':
        base = el.find(f'{_M}e')
        sub = el.find(f'{_M}sub')
        return f'{_omml_to_latex(base) if base is not None else ""}_{{{_omml_to_latex(sub) if sub is not None else ""}}}'
    if tag == 'sSubSup':
        base = el.find(f'{_M}e')
        sub = el.find(f'{_M}sub')
        sup = el.find(f'{_M}sup')
        b_s = _omml_to_latex(base) if base is not None else ''
        sub_s = _omml_to_latex(sub) if sub is not None else ''
        sup_s = _omml_to_latex(sup) if sup is not None else ''
        return f'{b_s}_{{{sub_s}}}^{{{sup_s}}}'
    if tag == 'rad':
        deg = el.find(f'{_M}deg')
        base = el.find(f'{_M}e')
        deg_s = _omml_to_latex(deg).strip() if deg is not None else ''
        b_s = _omml_to_latex(base) if base is not None else ''
        return f'\\sqrt[{deg_s}]{{{b_s}}}' if deg_s else f'\\sqrt{{{b_s}}}'
    if tag == 'nary':
        pr = el.find(f'{_M}naryPr')
        chr_el = pr.find(f'{_M}chr') if pr is not None else None
        op = chr_el.get(f'{_M}val', '∑') if chr_el is not None else '∑'
        op_map = {'∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∮': '\\oint'}
        op_tex = op_map.get(op, '\\sum')
        sub = el.find(f'{_M}sub')
        sup = el.find(f'{_M}sup')
        e = el.find(f'{_M}e')
        res = op_tex
        if sub is not None and _omml_to_latex(sub).strip():
            res += f'_{{{_omml_to_latex(sub)}}}'
        if sup is not None and _omml_to_latex(sup).strip():
            res += f'^{{{_omml_to_latex(sup)}}}'
        if e is not None:
            res += ' ' + _omml_to_latex(e)
        return res
    if tag == 'd':  # delimiter
        pr = el.find(f'{_M}dPr')
        beg = pr.find(f'{_M}begChr').get(f'{_M}val', '(') if pr is not None and pr.find(f'{_M}begChr') is not None else '('
        end = pr.find(f'{_M}endChr').get(f'{_M}val', ')') if pr is not None and pr.find(f'{_M}endChr') is not None else ')'
        inner = ', '.join(_omml_to_latex(c) for c in el.findall(f'{_M}e'))
        return f'\\left{beg}{inner}\\right{end}'
    if tag == 'm':  # matrix
        rows = []
        for mr in el.findall(f'{_M}mr'):
            cells = [_omml_to_latex(e) for e in mr.findall(f'{_M}e')]
            rows.append(' & '.join(cells))
        return '\\begin{pmatrix}' + ' \\\\ '.join(rows) + '\\end{pmatrix}'
    return ''.join(_omml_to_latex(c) for c in el)


# ------------------------------------------------------------------ Word Chart XML -> Chart Spec

def _parse_docx_chart(xml_bytes: bytes) -> dict[str, Any] | None:
    root = ET.fromstring(xml_bytes)
    title_el = root.find(f'.//{_C}title//{_C}t')
    title = title_el.text.strip() if title_el is not None and title_el.text else ''

    chart_type = None
    chart_node = None
    for tag, ctype in [('barChart', 'bar'), ('lineChart', 'line'), ('pieChart', 'pie'),
                       ('scatterChart', 'scatter'), ('areaChart', 'area')]:
        node = root.find(f'.//{_C}{tag}')
        if node is not None:
            chart_type = ctype
            chart_node = node
            break
    if chart_node is None:
        return None

    x_vals: list[str] = []
    series: list[dict[str, Any]] = []
    for ser in chart_node.findall(f'{_C}ser'):
        name_el = ser.find(f'.//{_C}tx//{_C}v')
        name = name_el.text.strip() if name_el is not None and name_el.text else f'系列{len(series) + 1}'
        cats = [v.text or '' for v in ser.findall(f'.//{_C}cat//{_C}v')]
        if cats and not x_vals:
            x_vals = cats
        vals_raw = [v.text for v in ser.findall(f'.//{_C}val//{_C}v')]
        if not vals_raw:
            vals_raw = [v.text for v in ser.findall(f'.//{_C}yVal//{_C}v')]
        nums: list[float] = []
        for vr in vals_raw:
            try:
                nums.append(float(vr))
            except (TypeError, ValueError):
                nums.append(0.0)
        if nums:
            series.append({'name': name, 'data': nums})
    if not series:
        return None
    spec: dict[str, Any] = {'type': chart_type, 'series': series}
    if title:
        spec['title'] = title
    if x_vals:
        spec['x'] = x_vals
    return spec


# ------------------------------------------------------------------ DOCX -> HTML

def _docx_numbering(zf: zipfile.ZipFile) -> dict[str, bool]:
    """Map numId -> ordered (True) / unordered (False)."""
    if 'word/numbering.xml' not in zf.namelist():
        return {}
    root = ET.fromstring(zf.read('word/numbering.xml'))
    abs_ordered: dict[str, bool] = {}
    for ab in root.findall(f'{_W}abstractNum'):
        aid = ab.get(f'{_W}abstractNumId', '')
        lvl = ab.find(f'{_W}lvl')
        fmt = lvl.find(f'{_W}numFmt') if lvl is not None else None
        val = fmt.get(f'{_W}val', 'bullet') if fmt is not None else 'bullet'
        abs_ordered[aid] = val != 'bullet'
    num_ordered: dict[str, bool] = {}
    for num in root.findall(f'{_W}num'):
        nid = num.get(f'{_W}numId', '')
        ref = num.find(f'{_W}abstractNumId')
        aid = ref.get(f'{_W}val', '') if ref is not None else ''
        num_ordered[nid] = abs_ordered.get(aid, False)
    return num_ordered


def _docx_rels(zf: zipfile.ZipFile) -> dict[str, str]:
    if 'word/_rels/document.xml.rels' not in zf.namelist():
        return {}
    root = ET.fromstring(zf.read('word/_rels/document.xml.rels'))
    rels: dict[str, str] = {}
    for rel in root.findall(f'{{{_REL_NS}}}Relationship'):
        rid = rel.get('Id', '')
        target = rel.get('Target', '')
        if rid and target:
            rels[rid] = target if target.startswith('word/') else f'word/{target.lstrip("/")}'
    return rels


def _run_to_html(r: ET.Element) -> str:
    rpr = r.find(f'{_W}rPr')
    bold = italic = underline = strike = sup = sub = False
    if rpr is not None:
        bold = rpr.find(f'{_W}b') is not None and rpr.find(f'{_W}b').get(f'{_W}val') != '0'
        italic = rpr.find(f'{_W}i') is not None and rpr.find(f'{_W}i').get(f'{_W}val') != '0'
        u_el = rpr.find(f'{_W}u')
        underline = u_el is not None and u_el.get(f'{_W}val', 'single') != 'none'
        strike = rpr.find(f'{_W}strike') is not None or rpr.find(f'{_W}dstrike') is not None
        va = rpr.find(f'{_W}vertAlign')
        if va is not None:
            vval = va.get(f'{_W}val', '')
            sup = vval == 'superscript'
            sub = vval == 'subscript'

    parts: list[str] = []
    for child in r:
        lt = _local(child.tag)
        if lt == 't':
            parts.append(html.escape(child.text or ''))
        elif lt == 'tab':
            parts.append('    ')
        elif lt == 'br':
            if child.get(f'{_W}type') == 'page':
                parts.append('<div style="page-break-after: always"></div>')
            else:
                parts.append('<br/>')
    txt = ''.join(parts)
    if not txt:
        return ''
    if sup:
        txt = f'<sup>{txt}</sup>'
    if sub:
        txt = f'<sub>{txt}</sub>'
    if bold:
        txt = f'<strong>{txt}</strong>'
    if italic:
        txt = f'<em>{txt}</em>'
    if underline:
        txt = f'<u>{txt}</u>'
    if strike:
        txt = f'<s>{txt}</s>'
    return txt


def _para_to_html(p: ET.Element, zf: zipfile.ZipFile, rels: dict[str, str],
                  num_ordered: dict[str, bool]) -> tuple[str, str | None]:
    """Returns (html_fragment, list_kind_or_None) where list_kind is 'ol'|'ul'|None."""
    ppr = p.find(f'{_W}pPr')
    tag = 'p'
    align_attr = ''
    list_kind = None

    if ppr is not None:
        ps = ppr.find(f'{_W}pStyle')
        if ps is not None:
            sv = (ps.get(f'{_W}val') or '').lower()
            if sv in ('title',):
                tag = 'h1'
            elif sv in ('subtitle',):
                tag = 'h2'
            elif sv.startswith('heading') or sv.startswith('标题'):
                m = re.search(r'(\d)', sv)
                lvl = min(6, max(1, int(m.group(1)))) if m else 1
                tag = f'h{lvl}'
        jc = ppr.find(f'{_W}jc')
        if jc is not None:
            jv = (jc.get(f'{_W}val') or '').lower()
            amap = {'left': 'left', 'center': 'center', 'right': 'right', 'both': 'justify', 'distribute': 'justify'}
            if jv in amap:
                align_attr = f' style="text-align:{amap[jv]}"'
        numpr = ppr.find(f'{_W}numPr')
        if numpr is not None:
            nid_el = numpr.find(f'{_W}numId')
            nid = nid_el.get(f'{_W}val', '') if nid_el is not None else ''
            if nid and nid != '0':
                list_kind = 'ol' if num_ordered.get(nid, False) else 'ul'

    inner: list[str] = []
    for child in p:
        lt = _local(child.tag)
        if lt == 'r':
            # Check for embedded chart inside drawing
            for chart_ref in child.iter(f'{{{_C_NS}}}chart'):
                rid = chart_ref.get(f'{{{_R_NS}}}id', '')
                target = rels.get(rid)
                if target and target in zf.namelist():
                    spec = _parse_docx_chart(zf.read(target))
                    if spec:
                        inner.append(f'<pre><code class="language-chart">{html.escape(json.dumps(spec, ensure_ascii=False))}</code></pre>')
            inner.append(_run_to_html(child))
        elif lt == 'hyperlink':
            ht = ''.join(_run_to_html(r) for r in child.findall(f'{_W}r'))
            if ht:
                inner.append(f'<a>{ht}</a>')
        elif lt == 'oMath':
            tex = _omml_to_latex(child).strip()
            if tex:
                inner.append(f'<span class="math-inline">${html.escape(tex)}$</span>')
        elif lt == 'oMathPara':
            om = child.find(f'{_M}oMath')
            tex = _omml_to_latex(om if om is not None else child).strip()
            if tex:
                inner.append(f'<div class="math-display">$${html.escape(tex)}$$</div>')

    content = ''.join(inner)
    if list_kind:
        return f'<li>{content}</li>', list_kind
    if not content.strip():
        return '', None
    if content.startswith('<pre><code') or content.startswith('<div class="math-display">'):
        return content, None
    return f'<{tag}{align_attr}>{content}</{tag}>', None


def _table_to_html(tbl: ET.Element, zf: zipfile.ZipFile, rels: dict[str, str],
                   num_ordered: dict[str, bool]) -> str:
    rows_html: list[str] = []
    for ri, tr in enumerate(tbl.findall(f'{_W}tr')):
        cells_html: list[str] = []
        cell_tag = 'th' if ri == 0 else 'td'
        for tc in tr.findall(f'{_W}tc'):
            parts: list[str] = []
            for p in tc.findall(f'{_W}p'):
                frag, _ = _para_to_html(p, zf, rels, num_ordered)
                if frag:
                    # strip outer <p> inside table cell
                    inner = re.sub(r'^<p[^>]*>(.*)</p>$', r'\1', frag, flags=re.DOTALL)
                    parts.append(inner)
            cells_html.append(f'<{cell_tag}>{"<br/>".join(parts)}</{cell_tag}>')
        rows_html.append(f'<tr>{"".join(cells_html)}</tr>')
    return f'<table>{"".join(rows_html)}</table>'


def import_docx(data: bytes) -> tuple[str, list[str]]:
    """Convert a .docx file to semantic HTML (+ math + charts)."""
    warnings: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            if 'word/document.xml' not in zf.namelist():
                raise ValueError('无效的 Word 文档（缺少 word/document.xml）')
            num_ordered = _docx_numbering(zf)
            rels = _docx_rels(zf)
            doc_root = ET.fromstring(zf.read('word/document.xml'))
            body = doc_root.find(f'{_W}body')
            if body is None:
                return '', warnings

            out: list[str] = []
            cur_list: str | None = None
            for child in body:
                lt = _local(child.tag)
                if lt == 'p':
                    frag, lkind = _para_to_html(child, zf, rels, num_ordered)
                    if lkind != cur_list:
                        if cur_list:
                            out.append(f'</{cur_list}>')
                        if lkind:
                            out.append(f'<{lkind}>')
                        cur_list = lkind
                    if frag:
                        out.append(frag)
                elif lt == 'tbl':
                    if cur_list:
                        out.append(f'</{cur_list}>')
                        cur_list = None
                    out.append(_table_to_html(child, zf, rels, num_ordered))
            if cur_list:
                out.append(f'</{cur_list}>')
            return '\n'.join(out), warnings
    except (zipfile.BadZipFile, ET.ParseError) as e:
        raise ValueError(f'无法解析 Word 文档：{e}')


def _extract_html_body(raw_html: str) -> str:
    m = re.search(r'<body[^>]*>(.*?)</body>', raw_html, flags=re.DOTALL | re.IGNORECASE)
    return m.group(1).strip() if m else raw_html.strip()


def import_rich_document(data: bytes, filename: str) -> dict[str, Any]:
    """Import .md / .markdown / .html / .htm / .docx / .txt -> {format, content, title, warnings}."""
    ext = os.path.splitext(filename.lower())[1]
    title = os.path.splitext(os.path.basename(filename))[0]
    if ext == '.docx':
        content, warnings = import_docx(data)
        return {'format': 'html', 'content': content, 'title': title, 'warnings': warnings}
    text, _enc = decode_text(data)
    if ext in ('.html', '.htm'):
        tm = re.search(r'<title[^>]*>(.*?)</title>', text, flags=re.DOTALL | re.IGNORECASE)
        if tm and tm.group(1).strip():
            title = html.unescape(tm.group(1).strip())
        return {'format': 'html', 'content': _extract_html_body(text), 'title': title, 'warnings': []}
    if ext in ('.md', '.markdown'):
        return {'format': 'markdown', 'content': text, 'title': title, 'warnings': []}
    return {'format': 'plain', 'content': text, 'title': title, 'warnings': []}
