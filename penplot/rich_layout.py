# -*- coding: utf-8 -*-
"""Rich text line-based layout engine for stationery (flow_text).

Lays out Rich Text IR blocks (Markdown / HTML / Word / LaTeX / Charts / Tables)
onto ruled pages (line_num lines per page) using the selected stroke font(s)
and handwriting jitter, returning per-page penplot Paths in mm (y-down).
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any, Optional

from .font_resolver import FontResolver
from .geometry import Affine2D, Path
from .layout import FontsSet, PageInfo, ParagraphFormat, _NO_LINE_START
from .layout_cache import GlyphPathCache
from .math_layout import render_handwritten_math
from .rich_renderers import render_chart_paths, render_svg_paths
from .rich_text import (
    Block, ChartBlock, CodeBlock, HeadingBlock, HrBlock, Inline, InlineMath,
    ListBlock, MathBlock, PageBreakBlock, ParagraphBlock, QuoteBlock, SvgBlock,
    TableBlock, TextRun, parse_rich,
)


@dataclass
class _RichItem:
    """Single inline atom (a glyph or an inline math formula) on a line."""
    paths: list[Path]
    adv: float
    step: float
    is_space: bool = False
    underline: bool = False
    strike: bool = False


class RichTextDocument:
    def __init__(self, page: PageInfo, font, fonts_set: Optional[FontsSet] = None,
                 settings=None, rng: Optional[random.Random] = None,
                 text_size: float = 1.0, char_space: float = 0.0,
                 font_mix=None, font_roles=None, missing_glyph: str = 'box',
                 rich_style: Optional[dict[str, Any]] = None,
                 layout_boxes: Optional[list[dict[str, Any]]] = None):
        self.page = page
        self.font = font
        self.fs = fonts_set or FontsSet()
        self.settings = settings
        self.rng = rng or random.Random()
        self._line_rng = random.Random(0)
        self._line_rng_state = self.rng.getstate()
        self.text_size = float(text_size or 1.0)
        self.char_space = float(char_space or 0.0)
        self.font_mix = font_mix
        self.font_roles = font_roles
        self._font_resolver = FontResolver(font, font_mix, font_roles)
        self.missing_glyph = missing_glyph or 'box'
        self.missing: set[str] = set()
        self._glyph_cache = GlyphPathCache()

        rs = rich_style or {}
        self.heading_scale = float(rs.get('heading_scale', 1.35) or 1.35)
        self.chart_lines = max(3, min(30, int(rs.get('chart_lines', 8) or 8)))
        self.math_scale = float(rs.get('math_scale', 1.0) or 1.0)
        self.table_header_repeat = bool(rs.get('table_header_repeat', True))
        self.table_hlines = bool(rs.get('table_hlines', False))
        self.code_box = bool(rs.get('code_box', True))

        # Page geometry in mm
        base_line_num = max(1, int(page.lineNum or 20))
        base_top = float(page.topGap)
        base_left = float(page.leftGap)
        base_body_w = max(1.0, float(page.pageWidth - page.leftGap - page.rightGap))
        base_body_h = max(1.0, float(page.pageHeight - page.topGap - page.bottomGap))
        base_line_h = base_body_h / base_line_num

        if layout_boxes:
            self._boxes: list[dict[str, Any]] = []
            for box in layout_boxes:
                if isinstance(box, dict):
                    gx, gy = box['x_mm'], box['y_mm']
                    gw, gh = box['w_mm'], box['h_mm']
                    gln = box.get('line_num')
                else:
                    gx, gy = box.x_mm, box.y_mm
                    gw, gh = box.w_mm, box.h_mm
                    gln = getattr(box, 'line_num', None)
                bw = max(1.0, float(gw))
                bh = max(1.0, float(gh))
                bln = max(1, int(gln)) if gln is not None else max(1, math.floor(base_line_num * bh / max(10, base_body_h) + 0.5))
                self._boxes.append({
                    'left_mm': float(gx),
                    'top_mm': float(gy),
                    'body_w': bw,
                    'body_h': bh,
                    'line_num': bln,
                    'line_h': bh / bln,
                })
        else:
            self._boxes = [{
                'left_mm': base_left,
                'top_mm': base_top,
                'body_w': base_body_w,
                'body_h': base_body_h,
                'line_num': base_line_num,
                'line_h': base_line_h,
            }]

        self._box_idx = 0
        self._line_idx = 0
        self._sync_box_attrs()

    # ------------------------------------------------------------------ font & glyph helpers

    def _pick_font(self, ch: str):
        return self._font_resolver.pick(ch, self.rng)

    def _rand(self, pair):
        lo, hi = pair[0], pair[1]
        return lo if lo == hi else lo + self.rng.random() * (hi - lo)

    def _glyph_paths(self, ch: str, line_h_mm: float, scale_mult: float = 1.0,
                     italic: bool = False,
                     apply_jitter: bool = True) -> tuple[list[Path], float]:
        """Build glyph Path(s) in local coords (y=0 at top of line_h_mm, baseline at 0.75*line_h_mm)."""
        fs = self.fs
        baseline = line_h_mm * 0.75 * fs.baseLine
        eff_size = self.text_size * scale_mult
        font = self._pick_font(ch)
        g = font.glyph(ch)
        if g is not None and g.ops:
            j_size = self._rand(fs.randomFontSize) if apply_jitter else 1.0
            j_xs = self._rand(fs.randomXScale) if apply_jitter else 1.0
            j_ys = self._rand(fs.randomYScale) if apply_jitter else 1.0
            j_rot = self._rand(fs.randomRotate) if apply_jitter else 0.0
            j_y = (self.rng.uniform(-fs.randomY, fs.randomY) * line_h_mm) if (apply_jitter and fs.randomY) else 0.0

            # Sampling and font selection always happen before lookup, so cache
            # hits cannot change handwriting randomness or subsequent wrapping.
            # Skip random variants: their near-unique keys only churn the cache.
            cache_key = None
            if not apply_jitter or (not fs.randomY and all(pair[0] == pair[1] for pair in
                    (fs.randomFontSize, fs.randomXScale, fs.randomYScale, fs.randomRotate))):
                cache_key = (id(font), ch, font.size, line_h_mm, eff_size, baseline,
                             j_size, j_xs, j_ys, j_rot, italic, apply_jitter,
                             fs.is_special_char(ch), fs.widthAdd, fs.simple)
                cached = self._glyph_cache.get(cache_key)
                if cached is not None:
                    path, advance = cached
                    return [path], advance

            sc = (line_h_mm / font.size) * j_size * eff_size
            p = Path(g.coords, g.ops)
            aff = Affine2D()
            aff.pre_scale(sc * j_xs, sc * j_ys)
            p.transform(aff)
            if j_rot:
                p.transform(Affine2D().rotate_deg_around(j_rot, 0.0, 0.0))
            bb = p.bbox()
            if bb is None:
                return [], 0.0
            shift = -bb[0] if bb[0] < 0.0 else 0.0
            adv = (bb[2] - bb[0]) + max(0.0, bb[0])
            if getattr(g, 'advance', None):
                adv = g.advance * (line_h_mm / font.size) * eff_size
            if fs.is_special_char(ch) and apply_jitter:
                shift += fs.widthAdd
                adv += shift
            p.transform(Affine2D().translate(shift, baseline + j_y))
            if italic:
                # Shear around baseline: x' = x - 0.22 * (y - baseline)
                c = p.coords
                for idx in range(0, len(c), 2):
                    c[idx] = c[idx] - 0.22 * (c[idx + 1] - baseline)
            if fs.simple > 0 and apply_jitter:
                p.rdp_simplify(fs.simple * 25.4 / 96.0)
            if cache_key is not None:
                self._glyph_cache.put(cache_key, p, adv)
            return [p], adv

        if ch == '\t':
            return [], line_h_mm * eff_size * 0.6
        if g is not None and getattr(g, 'advance', None):
            return [], g.advance * (line_h_mm / font.size) * eff_size
        adv = line_h_mm * eff_size * 0.3
        if ch == ' ':
            return [], adv
        self.missing.add(ch)
        if self.missing_glyph == 'skip':
            return [], adv
        box = Path()
        box.rect(0.0, baseline - line_h_mm * eff_size * 0.7, adv, line_h_mm * eff_size * 0.75)
        return [box], adv

    def draw_text_string(self, text: str, x_mm: float, baseline_y_mm: float,
                         font_h_mm: float, align: str = 'L') -> float:
        """Draw a plain string at (x_mm, baseline_y_mm) using the selected font. Returns width_mm."""
        # Used by charts! Note: _glyph_paths places baseline at 0.75 * line_h_mm
        virt_lh = font_h_mm / max(0.2, self.text_size)
        items: list[tuple[list[Path], float]] = []
        total_w = 0.0
        for ch in text:
            ps, adv = self._glyph_paths(ch, virt_lh, scale_mult=1.0, apply_jitter=False)
            items.append((ps, adv))
            total_w += adv + self.char_space
        if items:
            total_w -= self.char_space
        if align == 'C':
            cur_x = x_mm - total_w * 0.5
        elif align == 'R':
            cur_x = x_mm - total_w
        else:
            cur_x = x_mm
        dy = baseline_y_mm - virt_lh * 0.75 * self.fs.baseLine
        for ps, adv in items:
            for p in ps:
                p.transform(Affine2D().translate(cur_x, dy))
                self._cur_page.append(p)
            cur_x += adv + self.char_space
        return total_w

    def _math_glyph(self, ch: str, em_mm: float) -> tuple[list[Path], float]:
        """Glyph callback for math_layout: returns (paths with baseline y=0, advance_mm)."""
        virt_lh = em_mm / max(0.2, self.text_size)
        ps, adv = self._glyph_paths(ch, virt_lh, scale_mult=1.0, apply_jitter=True)
        base_y = virt_lh * 0.75 * self.fs.baseLine
        for p in ps:
            p.transform(Affine2D().translate(0.0, -base_y))
        return ps, adv

    # ------------------------------------------------------------------ pagination state

    def _sync_box_attrs(self):
        box = self._boxes[self._box_idx]
        self.left_mm = box['left_mm']
        self.top_mm = box['top_mm']
        self.body_w = box['body_w']
        self.body_h = box['body_h']
        self.line_num = box['line_num']
        self.line_h = box['line_h']

    def _reset_pages(self):
        self._pages: list[list[Path]] = [[]]
        self._cur_page = self._pages[0]
        self._box_idx = 0
        self._line_idx = 0
        self._used_pages = 1
        self._line_rng.setstate(self._line_rng_state)
        self._sync_box_attrs()

    def _new_page(self):
        self._pages.append([])
        self._cur_page = self._pages[-1]
        self._box_idx = 0
        self._line_idx = 0
        self._sync_box_attrs()

    def _next_box(self):
        if self._box_idx + 1 < len(self._boxes):
            self._box_idx += 1
            self._line_idx = 0
            self._sync_box_attrs()
        else:
            self._new_page()

    def _ensure_lines(self, needed: int):
        if self._line_idx > 0 and self._line_idx + needed > self.line_num:
            self._next_box()

    def _advance_lines(self, count: int = 1):
        self._used_pages = len(self._pages)
        self._line_idx += count
        if self._line_idx >= self.line_num:
            self._next_box()

    def _line_y(self, line_idx: Optional[int] = None) -> float:
        idx = self._line_idx if line_idx is None else line_idx
        return self.top_mm + idx * self.line_h

    def _box_frame(self, fmt: ParagraphFormat, indent_left: float = 0.0) -> tuple[float, float]:
        base_left = self.left_mm + fmt.left + indent_left
        avail = max(min(10.0, self.body_w), self.body_w - fmt.left - indent_left - fmt.right)
        return base_left, avail

    # ------------------------------------------------------------------ inline layout & wrapping

    def _build_math_item(self, latex: str, line_h: float, scale_mult: float) -> _RichItem:
        em = line_h * self.text_size * scale_mult * self.math_scale * 0.9
        mpaths, mw, _mh, mb = render_handwritten_math(latex, em, self._math_glyph, display=False)
        # Align math baseline (mb) with the text baseline
        text_base = line_h * 0.75 * self.fs.baseLine
        y_off = text_base - mb
        for mp in mpaths:
            mp.transform(Affine2D().translate(0.0, y_off))
        gap_mm = self.char_space + self.page.space
        return _RichItem(mpaths, mw, mw + gap_mm)

    def _build_char_item(self, ch: str, run: TextRun, line_h: float, scale_mult: float) -> _RichItem:
        # Bold remains an editor/IR style; a pen writes each glyph only once.
        sc = scale_mult * (0.68 if (run.sup or run.sub) else 1.0)
        y_shift = (-line_h * 0.22) if run.sup else ((line_h * 0.16) if run.sub else 0.0)
        ps, adv = self._glyph_paths(ch, line_h, scale_mult=sc, italic=run.italic)
        if y_shift:
            for p in ps:
                p.transform(Affine2D().translate(0.0, y_shift))
        p_gap = self.page.space * self._rand(self.fs.randomSpace)
        step = adv + self.char_space + p_gap
        return _RichItem(
            ps, adv, step, is_space=(ch == ' '),
            underline=run.underline, strike=run.strike,
        )

    def _runs_to_wrapped_lines(self, runs: list[Inline], first_w: float, rest_w: float,
                               scale_mult: float = 1.0) -> list[list[_RichItem]]:
        """Wrap inline runs (TextRun + InlineMath) into lines of _RichItem."""
        lines: list[list[_RichItem]] = []
        cur: list[_RichItem] = []
        cur_w = 0.0
        avail = first_w

        def push_line():
            nonlocal cur, cur_w, avail
            lines.append(cur)
            cur = []
            cur_w = 0.0
            avail = rest_w

        for run in runs:
            if isinstance(run, InlineMath):
                item = self._build_math_item(run.latex, self.line_h, scale_mult)
                if cur and cur_w + item.adv > avail:
                    push_line()
                cur.append(item)
                cur_w += item.step
                continue

            for ch in run.text:
                if ch == '\r':
                    continue
                if ch == '\n':
                    push_line()
                    continue
                item = self._build_char_item(ch, run, self.line_h, scale_mult)
                if cur and cur_w + item.adv > avail and ch not in _NO_LINE_START:
                    push_line()
                cur.append(item)
                cur_w += item.step

        if cur or not lines:
            lines.append(cur)
        return lines

    def _layout_runs(self, runs: list[Inline], scale_mult: float,
                     prepare_line, emit_line):
        """Stream inline runs line-by-line so each line wraps to the current box width and line_h."""
        run_idx = 0
        char_idx = 0
        line_idx = 0
        emitted_any = False
        pending: Optional[tuple[Any, _RichItem, float]] = None

        def advance_cursor():
            nonlocal run_idx, char_idx
            while run_idx < len(runs):
                r = runs[run_idx]
                if isinstance(r, InlineMath):
                    return
                if char_idx < len(r.text):
                    if r.text[char_idx] == '\r':
                        char_idx += 1
                        continue
                    return
                run_idx += 1
                char_idx = 0

        advance_cursor()
        while run_idx < len(runs) or pending is not None:
            avail, cur_lh = prepare_line(line_idx)
            cur: list[_RichItem] = []
            cur_w = 0.0

            if pending is not None:
                spec, item, built_lh = pending
                pending = None
                if built_lh != cur_lh:
                    if spec[0] == 'math':
                        item = self._build_math_item(spec[1], cur_lh, scale_mult)
                    else:
                        item = self._build_char_item(spec[1], spec[2], cur_lh, scale_mult)
                cur.append(item)
                cur_w += item.step

            line_closed = False
            while run_idx < len(runs) and not line_closed:
                run = runs[run_idx]
                if isinstance(run, InlineMath):
                    item = self._build_math_item(run.latex, cur_lh, scale_mult)
                    run_idx += 1
                    char_idx = 0
                    advance_cursor()
                    if cur and cur_w + item.adv > avail:
                        emit_line(line_idx, cur)
                        line_idx += 1
                        emitted_any = True
                        pending = (('math', run.latex), item, cur_lh)
                        line_closed = True
                        break
                    cur.append(item)
                    cur_w += item.step
                    continue

                text = run.text
                while char_idx < len(text):
                    ch = text[char_idx]
                    char_idx += 1
                    if ch == '\r':
                        continue
                    if ch == '\n':
                        advance_cursor()
                        emit_line(line_idx, cur)
                        line_idx += 1
                        emitted_any = True
                        line_closed = True
                        break
                    item = self._build_char_item(ch, run, cur_lh, scale_mult)
                    if cur and cur_w + item.adv > avail and ch not in _NO_LINE_START:
                        advance_cursor()
                        emit_line(line_idx, cur)
                        line_idx += 1
                        emitted_any = True
                        pending = (('char', ch, run), item, cur_lh)
                        line_closed = True
                        break
                    cur.append(item)
                    cur_w += item.step
                if not line_closed:
                    advance_cursor()

            if not line_closed:
                if cur or not emitted_any:
                    emit_line(line_idx, cur)
                    line_idx += 1
                    emitted_any = True

        if not emitted_any:
            prepare_line(0)
            emit_line(0, [])

    def _emit_line(self, items: list[_RichItem], x_start: float, avail_w: float,
                   y_top: float, align: str, scale_mult: float = 1.0):
        content_w = sum(it.step for it in items)
        if align == 'R':
            off = max(0.0, avail_w - content_w)
        elif align == 'C':
            off = max(0.0, (avail_w - content_w) * 0.5)
        else:
            off = 0.0
        if self.fs.randomFirstPos:
            off += self._line_rng.random() * self.fs.randomFirstPos

        extra = 0.0
        if align == 'D' and len(items) > 1:
            non_zero = sum(1 for it in items if not it.is_space and it.adv > 0)
            if non_zero > 1:
                extra = max(0.0, (avail_w - content_w) / (non_zero - 1))

        baseline_y = y_top + self.line_h * 0.75 * self.fs.baseLine
        rel = 0.0
        for it in items:
            x = x_start + off + rel
            for p in it.paths:
                e = p.clone()
                e.transform(Affine2D().translate(x, y_top))
                self._cur_page.append(e)
            if it.underline and it.adv > 0:
                u = Path()
                uy = baseline_y + self.line_h * self.text_size * scale_mult * 0.14
                u.move_to(x, uy)
                u.line_to(x + it.step, uy)
                self._cur_page.append(u)
            if it.strike and it.adv > 0:
                s = Path()
                sy = baseline_y - self.line_h * self.text_size * scale_mult * 0.28
                s.move_to(x, sy)
                s.line_to(x + it.step, sy)
                self._cur_page.append(s)
            rel += it.step + extra

    # ------------------------------------------------------------------ block layout

    def _layout_blocks(self, blocks: list[Block], fmt: ParagraphFormat,
                       default_align: str, indent_left: float = 0.0,
                       quote_depth: int = 0):
        for blk in blocks:
            if isinstance(blk, PageBreakBlock):
                if self._line_idx > 0 or self._box_idx > 0 or len(self._cur_page) > 0:
                    self._new_page()
                continue

            if isinstance(blk, HrBlock):
                self._ensure_lines(1)
                self._advance_lines(1)
                continue

            if isinstance(blk, HeadingBlock):
                # H1..H6 scale relative to heading_scale
                lvl_factor = max(1.0, self.heading_scale - (blk.level - 1) * 0.12)
                align = blk.align or default_align

                def _prepare_heading(_li, _lf=lvl_factor):
                    lines_per_row = 2 if (_lf >= 1.3 and self.line_num >= 2) else 1
                    self._ensure_lines(lines_per_row)
                    _, avail_base = self._box_frame(fmt, indent_left)
                    return avail_base, self.line_h

                def _emit_heading(_li, wl, _lf=lvl_factor, _al=align):
                    lines_per_row = 2 if (_lf >= 1.3 and self.line_num >= 2) else 1
                    base_left, avail_base = self._box_frame(fmt, indent_left)
                    y_top = self._line_y()
                    # Vertically center inside the allocated lines
                    y_draw = y_top + (lines_per_row - 1) * self.line_h * 0.5
                    self._emit_line(wl, base_left, avail_base, y_draw, _al, scale_mult=_lf)
                    if quote_depth:
                        self._draw_quote_bars(quote_depth, y_top, lines_per_row)
                    self._advance_lines(lines_per_row)

                self._layout_runs(blk.runs, lvl_factor, _prepare_heading, _emit_heading)
                continue

            if isinstance(blk, ParagraphBlock):
                align = blk.align or default_align
                if align in ('C', 'R'):
                    spe1 = 0.0
                    spe2 = 0.0
                else:
                    spe1 = fmt.spe_value if fmt.spe_type == 1 else 0.0
                    spe2 = fmt.spe_value if fmt.spe_type == 2 else 0.0

                def _para_geom(li, _s1=spe1, _s2=spe2):
                    base_left, avail_base = self._box_frame(fmt, indent_left)
                    ind = _s1 if li == 0 else _s2
                    w_line = max(min(8.0, avail_base), avail_base - ind)
                    return base_left, ind, w_line

                def _prepare_para(li):
                    self._ensure_lines(1)
                    _, _, w_line = _para_geom(li)
                    return w_line, self.line_h

                def _emit_para(li, wl, _al=align):
                    base_left, ind, w_line = _para_geom(li)
                    y_top = self._line_y()
                    self._emit_line(wl, base_left + ind, w_line, y_top, _al)
                    if quote_depth:
                        self._draw_quote_bars(quote_depth, y_top, 1)
                    self._advance_lines(1)

                self._layout_runs(blk.runs, 1.0, _prepare_para, _emit_para)
                continue

            if isinstance(blk, QuoteBlock):
                q_indent = 5.0
                self._layout_blocks(blk.blocks, fmt, default_align,
                                    indent_left=indent_left + q_indent,
                                    quote_depth=quote_depth + 1)
                continue

            if isinstance(blk, ListBlock):
                marker_w = 5.5
                for idx, item in enumerate(blk.items):
                    num = blk.start + idx
                    prefix = f'{num}.' if blk.ordered else '•'

                    def _prepare_li(_li):
                        self._ensure_lines(1)
                        _, avail_base = self._box_frame(fmt, indent_left)
                        w_line = max(min(8.0, avail_base), avail_base - marker_w)
                        return w_line, self.line_h

                    def _emit_li(li, wl, _prefix=prefix, _ordered=blk.ordered):
                        base_left, avail_base = self._box_frame(fmt, indent_left)
                        w_line = max(min(8.0, avail_base), avail_base - marker_w)
                        y_top = self._line_y()
                        if li == 0:
                            if _ordered:
                                self.draw_text_string(_prefix, base_left + 0.5,
                                                      y_top + self.line_h * 0.75 * self.fs.baseLine,
                                                      self.line_h * self.text_size * 0.9, 'L')
                            else:
                                # Draw small crisp bullet circle
                                bx = base_left + 2.2
                                by = y_top + self.line_h * 0.52
                                br = max(0.5, min(1.0, self.line_h * 0.11))
                                bp = Path()
                                for k in range(9):
                                    a = k * math.tau / 8
                                    px, py = bx + br * math.cos(a), by + br * math.sin(a)
                                    bp.move_to(px, py) if k == 0 else bp.line_to(px, py)
                                self._cur_page.append(bp)
                        self._emit_line(wl, base_left + marker_w, w_line, y_top, 'L')
                        if quote_depth:
                            self._draw_quote_bars(quote_depth, y_top, 1)
                        self._advance_lines(1)

                    self._layout_runs(item.runs, 1.0, _prepare_li, _emit_li)
                    if item.children:
                        self._layout_blocks(item.children, fmt, default_align,
                                            indent_left=indent_left + marker_w,
                                            quote_depth=quote_depth)
                continue

            if isinstance(blk, CodeBlock):
                pad = 2.0
                code_lines = blk.code.split('\n')
                box_start_line: Optional[int] = None
                box_left = 0.0
                box_w = 0.0

                def _flush_code_box():
                    nonlocal box_start_line
                    if self.code_box and box_start_line is not None and self._line_idx > box_start_line:
                        self._draw_box(box_left, self._line_y(box_start_line), box_w,
                                       (self._line_idx - box_start_line) * self.line_h)
                    box_start_line = None

                for cl in code_lines:
                    def _prepare_code(_li):
                        nonlocal box_start_line, box_left, box_w
                        if self._line_idx >= self.line_num:
                            _flush_code_box()
                            self._next_box()
                        base_left, avail_base = self._box_frame(fmt, indent_left)
                        if box_start_line is None:
                            box_start_line = self._line_idx
                            box_left = base_left
                            box_w = avail_base
                        cw = max(min(8.0, avail_base), avail_base - pad * 2)
                        return cw, self.line_h

                    def _emit_code(_li, wl):
                        base_left, avail_base = self._box_frame(fmt, indent_left)
                        cw = max(min(8.0, avail_base), avail_base - pad * 2)
                        y_top = self._line_y()
                        self._emit_line(wl, base_left + pad, cw, y_top, 'L', scale_mult=0.88)
                        self._line_idx += 1
                        if self._line_idx >= self.line_num:
                            _flush_code_box()
                            self._next_box()

                    self._layout_runs([TextRun(cl or ' ', code=True)], 0.88, _prepare_code, _emit_code)

                _flush_code_box()
                if self._line_idx >= self.line_num:
                    self._next_box()
                continue

            if isinstance(blk, MathBlock):
                def _measure_math():
                    base_left, avail_base = self._box_frame(fmt, indent_left)
                    em = self.line_h * self.text_size * 0.98 * self.math_scale
                    mpaths, mw, mh, _mb = render_handwritten_math(blk.latex, em, self._math_glyph, display=True)
                    if mw > avail_base and mw > 0:
                        s = avail_base / mw
                        for mp in mpaths:
                            mp.transform(Affine2D().scale(s, s))
                        mw *= s
                        mh *= s
                    needed = max(1, int(math.ceil(mh / self.line_h)))
                    needed = min(needed, self.line_num)
                    return base_left, avail_base, mpaths, mw, mh, needed

                base_left, avail_base, mpaths, mw, mh, needed = _measure_math()
                if self._line_idx > 0 and self._line_idx + needed > self.line_num:
                    self._next_box()
                    base_left, avail_base, mpaths, mw, mh, needed = _measure_math()
                y_top = self._line_y()
                x_off = base_left + max(0.0, (avail_base - mw) * 0.5)
                y_off = y_top + max(0.0, (needed * self.line_h - mh) * 0.5)
                for mp in mpaths:
                    mp.transform(Affine2D().translate(x_off, y_off))
                    self._cur_page.append(mp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, ChartBlock):
                needed = min(self.line_num, max(3, int(blk.spec.get('lines') or self.chart_lines)))
                self._ensure_lines(needed)
                needed = min(self.line_num, max(3, int(blk.spec.get('lines') or self.chart_lines)))
                base_left, avail_base = self._box_frame(fmt, indent_left)
                y_top = self._line_y()
                ch_h = needed * self.line_h - 1.5
                def _chart_text(t: str, tx: float, ty: float, th: float, al: str,
                                _bl=base_left, _yt=y_top) -> float:
                    return self.draw_text_string(t, _bl + tx, _yt + ty, th, al)
                cpaths = render_chart_paths(blk.spec, avail_base, ch_h,
                                            self.line_h * self.text_size, _chart_text)
                for cp in cpaths:
                    cp.transform(Affine2D().translate(base_left, y_top))
                    self._cur_page.append(cp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, SvgBlock):
                def _measure_svg():
                    base_left, avail_base = self._box_frame(fmt, indent_left)
                    max_lines = min(self.line_num, self.chart_lines)
                    spaths, sw, sh = render_svg_paths(
                        blk.svg, avail_base, max_lines * self.line_h,
                        font_for=lambda _fams: self.font,
                        fonts_set=self.fs, rng=self.rng, missing=self.missing,
                        missing_glyph=self.missing_glyph,
                    )
                    needed = max(1, min(self.line_num, int(math.ceil(sh / self.line_h))))
                    return base_left, avail_base, spaths, sw, sh, needed

                base_left, avail_base, spaths, sw, sh, needed = _measure_svg()
                if self._line_idx > 0 and self._line_idx + needed > self.line_num:
                    self._next_box()
                    base_left, avail_base, spaths, sw, sh, needed = _measure_svg()
                y_top = self._line_y()
                x_off = base_left + max(0.0, (avail_base - sw) * 0.5)
                y_off = y_top + max(0.0, (needed * self.line_h - sh) * 0.5)
                for sp in spaths:
                    sp.transform(Affine2D().translate(x_off, y_off))
                    self._cur_page.append(sp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, TableBlock):
                self._layout_table(blk, fmt, indent_left)
                continue

    def _draw_quote_bars(self, depth: int, y_top: float, lines: int):
        for d in range(depth):
            bx = self.left_mm + d * 5.0 + 1.5
            p = Path()
            p.move_to(bx, y_top + 0.4)
            p.line_to(bx, y_top + lines * self.line_h - 0.4)
            self._cur_page.append(p)

    def _draw_box(self, x: float, y: float, w: float, h: float):
        p = Path()
        p.rect(x, y + 0.3, w, max(0.5, h - 0.6))
        self._cur_page.append(p)

    def _layout_table(self, tbl: TableBlock, fmt: ParagraphFormat, indent_left: float = 0.0):
        ncols = max(len(tbl.headers), max((len(r) for r in tbl.rows), default=0))
        if ncols <= 0:
            return
        pad_x = 1.5

        def box_table_geom():
            x0, avail_w = self._box_frame(fmt, indent_left)
            col_w = avail_w / ncols
            inner_w = max(4.0, col_w - pad_x * 2)
            return x0, avail_w, col_w, inner_w

        def prepare_row(cells: list[list[Inline]], inner_w: float) -> list[list[list[_RichItem]]]:
            wrapped_cols = []
            for ci in range(ncols):
                runs = cells[ci] if ci < len(cells) else []
                wrapped_cols.append(self._runs_to_wrapped_lines(runs, inner_w, inner_w,
                                                                scale_mult=0.92))
            return wrapped_cols

        def draw_row(wrapped_cols: list[list[list[_RichItem]]], is_hdr: bool,
                     x0: float, avail_w: float, col_w: float, inner_w: float):
            row_lines = max(1, max(len(wc) for wc in wrapped_cols))
            y_row_top = self._line_y()
            for li in range(row_lines):
                y_line = self._line_y()
                for ci, wc in enumerate(wrapped_cols):
                    if li < len(wc):
                        al = tbl.aligns[ci] if ci < len(tbl.aligns) else 'L'
                        self._emit_line(wc[li], x0 + ci * col_w + pad_x, inner_w, y_line, al, scale_mult=0.92)
                self._line_idx += 1
            row_h = row_lines * self.line_h
            # Draw cell borders: vertical lines always; horizontal lines only when table_hlines is True
            if self.table_hlines:
                box = Path()
                box.rect(x0, y_row_top, avail_w, row_h)
                self._cur_page.append(box)
            else:
                for vx in (x0, x0 + avail_w):
                    vp = Path()
                    vp.move_to(vx, y_row_top)
                    vp.line_to(vx, y_row_top + row_h)
                    self._cur_page.append(vp)
            for ci in range(1, ncols):
                vx = x0 + ci * col_w
                vp = Path()
                vp.move_to(vx, y_row_top)
                vp.line_to(vx, y_row_top + row_h)
                self._cur_page.append(vp)
            if is_hdr and self.table_hlines:
                hp = Path()
                hp.move_to(x0, y_row_top + row_h - 0.35)
                hp.line_to(x0 + avail_w, y_row_top + row_h - 0.35)
                self._cur_page.append(hp)

        x0, avail_w, col_w, inner_w = box_table_geom()
        hdr_wrapped = prepare_row(tbl.headers, inner_w) if tbl.headers else None
        raw_rows = ([('hdr', tbl.headers)] if tbl.headers else []) + [('row', r) for r in tbl.rows]

        for kind, cells in raw_rows:
            wcols = hdr_wrapped if (kind == 'hdr' and hdr_wrapped is not None) else prepare_row(cells, inner_w)
            needed = max(1, max(len(wc) for wc in wcols))
            if self._line_idx > 0 and self._line_idx + needed > self.line_num:
                prev_box = (self.body_w, self.line_h)
                self._next_box()
                x0, avail_w, col_w, inner_w = box_table_geom()
                if (self.body_w, self.line_h) != prev_box:
                    hdr_wrapped = prepare_row(tbl.headers, inner_w) if tbl.headers else None
                    wcols = hdr_wrapped if (kind == 'hdr' and hdr_wrapped is not None) else prepare_row(cells, inner_w)
                    needed = max(1, max(len(wc) for wc in wcols))
                if kind == 'row' and hdr_wrapped and self.table_header_repeat:
                    h_need = max(1, max(len(wc) for wc in hdr_wrapped))
                    if self._line_idx + h_need + needed <= self.line_num:
                        draw_row(hdr_wrapped, True, x0, avail_w, col_w, inner_w)
            draw_row(wcols, kind == 'hdr', x0, avail_w, col_w, inner_w)
            if self._line_idx >= self.line_num:
                prev_box = (self.body_w, self.line_h)
                self._next_box()
                x0, avail_w, col_w, inner_w = box_table_geom()
                if (self.body_w, self.line_h) != prev_box:
                    hdr_wrapped = prepare_row(tbl.headers, inner_w) if tbl.headers else None

    # ------------------------------------------------------------------ public API

    def layout_and_render(self, content: str, fmt_name: str = 'markdown',
                          para_fmt: Optional[ParagraphFormat] = None,
                          align: str = 'L') -> list[list[Path]]:
        """Parse rich content and lay it out into per-page Path lists (mm, y-down)."""
        self._reset_pages()
        blocks = parse_rich(content, fmt_name)
        self._layout_blocks(blocks, para_fmt or ParagraphFormat(), align)
        # Keep laid-out blank lines, including a continuation page ready for typing.
        while len(self._pages) > self._used_pages and not self._pages[-1]:
            self._pages.pop()
        return self._pages or [[]]
