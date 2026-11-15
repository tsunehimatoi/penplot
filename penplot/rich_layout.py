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

from .geometry import Affine2D, Path
from .layout import FontsSet, LineAlign, PageInfo, ParagraphFormat, _NO_LINE_START
from .rich_renderers import render_chart_paths, render_latex_paths, render_svg_paths
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
    bold: bool = False


class RichTextDocument:
    def __init__(self, page: PageInfo, font, fonts_set: Optional[FontsSet] = None,
                 settings=None, rng: Optional[random.Random] = None,
                 text_size: float = 1.0, char_space: float = 0.0,
                 font_mix=None, missing_glyph: str = 'box',
                 rich_style: Optional[dict[str, Any]] = None):
        self.page = page
        self.font = font
        self.fs = fonts_set or FontsSet()
        self.settings = settings
        self.rng = rng or random.Random()
        self.text_size = float(text_size or 1.0)
        self.char_space = float(char_space or 0.0)
        self.font_mix = font_mix
        self.missing_glyph = missing_glyph or 'box'
        self.missing: set[str] = set()

        rs = rich_style or {}
        self.heading_scale = float(rs.get('heading_scale', 1.35) or 1.35)
        self.chart_lines = max(3, min(30, int(rs.get('chart_lines', 8) or 8)))
        self.math_scale = float(rs.get('math_scale', 1.0) or 1.0)
        self.table_header_repeat = bool(rs.get('table_header_repeat', True))
        self.code_box = bool(rs.get('code_box', True))

        # Page geometry in mm
        self.line_num = max(1, int(page.lineNum or 20))
        self.top_mm = float(page.topGap)
        self.left_mm = float(page.leftGap)
        self.body_w = max(10.0, float(page.pageWidth - page.leftGap - page.rightGap))
        self.body_h = max(10.0, float(page.pageHeight - page.topGap - page.bottomGap))
        self.line_h = self.body_h / self.line_num

    # ------------------------------------------------------------------ font & glyph helpers

    def _pick_font(self, ch: str):
        if not self.font_mix:
            return self.font
        total = sum(w for _f, w in self.font_mix if w > 0)
        if total <= 0:
            return self.font_mix[0][0] if self.font_mix else self.font
        r = self.rng.random() * total
        acc = 0.0
        pick = self.font_mix[0][0]
        for f, w in self.font_mix:
            if w <= 0:
                continue
            acc += w
            if r <= acc:
                pick = f
                break
        if pick.has_glyph(ch):
            return pick
        for f, _w in self.font_mix:
            if f.has_glyph(ch):
                return f
        return pick

    def _rand(self, pair):
        lo, hi = pair[0], pair[1]
        return lo if lo == hi else lo + self.rng.random() * (hi - lo)

    def _glyph_paths(self, ch: str, line_h_mm: float, scale_mult: float = 1.0,
                     bold: bool = False, italic: bool = False,
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

            sc = (line_h_mm / font.size) * j_size * eff_size
            p = Path(list(g.coords), list(g.ops))
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
            out = [p]
            if bold:
                p2 = p.clone()
                p2.transform(Affine2D().translate(min(0.14, line_h_mm * eff_size * 0.03), 0.0))
                out.append(p2)
            return out, adv

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

    # ------------------------------------------------------------------ pagination state

    def _reset_pages(self):
        self._pages: list[list[Path]] = [[]]
        self._cur_page = self._pages[0]
        self._line_idx = 0

    def _new_page(self):
        self._pages.append([])
        self._cur_page = self._pages[-1]
        self._line_idx = 0

    def _ensure_lines(self, needed: int):
        if self._line_idx > 0 and self._line_idx + needed > self.line_num:
            self._new_page()

    def _advance_lines(self, count: int = 1):
        self._line_idx += count
        if self._line_idx >= self.line_num:
            self._new_page()

    def _line_y(self, line_idx: Optional[int] = None) -> float:
        idx = self._line_idx if line_idx is None else line_idx
        return self.top_mm + idx * self.line_h

    # ------------------------------------------------------------------ inline layout & wrapping

    def _runs_to_wrapped_lines(self, runs: list[Inline], first_w: float, rest_w: float,
                               scale_mult: float = 1.0, force_bold: bool = False) -> list[list[_RichItem]]:
        """Wrap inline runs (TextRun + InlineMath) into lines of _RichItem."""
        lines: list[list[_RichItem]] = []
        cur: list[_RichItem] = []
        cur_w = 0.0
        avail = first_w
        gap_mm = self.char_space + self.page.space

        def push_line():
            nonlocal cur, cur_w, avail
            lines.append(cur)
            cur = []
            cur_w = 0.0
            avail = rest_w

        for run in runs:
            if isinstance(run, InlineMath):
                em = self.line_h * self.text_size * scale_mult * self.math_scale
                mpaths, mw, mh, _mb = render_latex_paths(run.latex, em)
                # Center vertically around text middle
                y_off = max(0.0, (self.line_h - mh) * 0.5)
                for mp in mpaths:
                    mp.transform(Affine2D().translate(0.0, y_off))
                step = mw + gap_mm
                if cur and cur_w + mw > avail:
                    push_line()
                cur.append(_RichItem(mpaths, mw, step))
                cur_w += step
                continue

            # TextRun
            sc = scale_mult * (0.68 if (run.sup or run.sub) else 1.0)
            y_shift = (-self.line_h * 0.22) if run.sup else ((self.line_h * 0.16) if run.sub else 0.0)
            for ch in run.text:
                if ch == '\r':
                    continue
                if ch == '\n':
                    push_line()
                    continue
                ps, adv = self._glyph_paths(
                    ch, self.line_h, scale_mult=sc,
                    bold=force_bold or run.bold, italic=run.italic,
                )
                if y_shift:
                    for p in ps:
                        p.transform(Affine2D().translate(0.0, y_shift))
                p_gap = self.page.space * self._rand(self.fs.randomSpace)
                step = adv + self.char_space + p_gap
                if cur and cur_w + adv > avail and ch not in _NO_LINE_START:
                    push_line()
                cur.append(_RichItem(
                    ps, adv, step, is_space=(ch == ' '),
                    underline=run.underline, strike=run.strike, bold=force_bold or run.bold,
                ))
                cur_w += step

        if cur or not lines:
            lines.append(cur)
        return lines

    def _emit_line(self, items: list[_RichItem], x_start: float, avail_w: float,
                   y_top: float, align: str, scale_mult: float = 1.0):
        content_w = sum(it.step for it in items)
        if align == 'R':
            off = max(0.0, avail_w - content_w)
        elif align == 'C':
            off = max(0.0, (avail_w - content_w) * 0.5)
        else:
            off = 0.0

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
        base_left = self.left_mm + fmt.left + indent_left
        base_right = fmt.right
        avail_base = max(10.0, self.body_w - fmt.left - indent_left - base_right)

        for blk in blocks:
            if isinstance(blk, PageBreakBlock):
                if self._line_idx > 0 or len(self._cur_page) > 0:
                    self._new_page()
                continue

            if isinstance(blk, HrBlock):
                self._ensure_lines(1)
                y = self._line_y() + self.line_h * 0.5
                p = Path()
                p.move_to(base_left, y)
                p.line_to(base_left + avail_base, y)
                self._cur_page.append(p)
                self._advance_lines(1)
                continue

            if isinstance(blk, HeadingBlock):
                # H1..H6 scale relative to heading_scale
                lvl_factor = max(1.0, self.heading_scale - (blk.level - 1) * 0.12)
                lines_per_row = 2 if lvl_factor >= 1.3 else 1
                wrapped = self._runs_to_wrapped_lines(blk.runs, avail_base, avail_base,
                                                      scale_mult=lvl_factor, force_bold=True)
                align = blk.align or default_align
                for wl in wrapped:
                    self._ensure_lines(lines_per_row)
                    y_top = self._line_y()
                    # Vertically center inside the allocated lines
                    y_draw = y_top + (lines_per_row - 1) * self.line_h * 0.5
                    self._emit_line(wl, base_left, avail_base, y_draw, align, scale_mult=lvl_factor)
                    if quote_depth:
                        self._draw_quote_bars(quote_depth, y_top, lines_per_row)
                    self._advance_lines(lines_per_row)
                if blk.level <= 2 and self._line_idx > 0:
                    uy = self._line_y() - self.line_h * 0.12
                    rule = Path()
                    rule.move_to(base_left, uy)
                    rule.line_to(base_left + avail_base, uy)
                    self._cur_page.append(rule)
                continue

            if isinstance(blk, ParagraphBlock):
                spe1 = fmt.spe_value if fmt.spe_type == 1 else 0.0
                spe2 = fmt.spe_value if fmt.spe_type == 2 else 0.0
                first_w = max(8.0, avail_base - spe1)
                rest_w = max(8.0, avail_base - spe2)
                wrapped = self._runs_to_wrapped_lines(blk.runs, first_w, rest_w)
                align = blk.align or default_align
                for li, wl in enumerate(wrapped):
                    self._ensure_lines(1)
                    y_top = self._line_y()
                    ind = spe1 if li == 0 else spe2
                    w_line = first_w if li == 0 else rest_w
                    self._emit_line(wl, base_left + ind, w_line, y_top, align)
                    if quote_depth:
                        self._draw_quote_bars(quote_depth, y_top, 1)
                    self._advance_lines(1)
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
                    first_w = max(8.0, avail_base - marker_w)
                    wrapped = self._runs_to_wrapped_lines(item.runs, first_w, first_w)
                    for li, wl in enumerate(wrapped):
                        self._ensure_lines(1)
                        y_top = self._line_y()
                        if li == 0:
                            if blk.ordered:
                                self.draw_text_string(prefix, base_left + 0.5,
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
                        self._emit_line(wl, base_left + marker_w, first_w, y_top, 'L')
                        if quote_depth:
                            self._draw_quote_bars(quote_depth, y_top, 1)
                        self._advance_lines(1)
                    if item.children:
                        self._layout_blocks(item.children, fmt, default_align,
                                            indent_left=indent_left + marker_w,
                                            quote_depth=quote_depth)
                continue

            if isinstance(blk, CodeBlock):
                pad = 2.0
                cw = max(8.0, avail_base - pad * 2)
                code_lines = blk.code.split('\n')
                wrapped_all: list[list[_RichItem]] = []
                for cl in code_lines:
                    wrapped_all.extend(self._runs_to_wrapped_lines([TextRun(cl or ' ', code=True)], cw, cw, scale_mult=0.88))
                start_line = self._line_idx
                for wi, wl in enumerate(wrapped_all):
                    if self._line_idx >= self.line_num:
                        if self.code_box and self._line_idx > start_line:
                            self._draw_box(base_left, self._line_y(start_line), avail_base,
                                           (self._line_idx - start_line) * self.line_h)
                        self._new_page()
                        start_line = 0
                    y_top = self._line_y()
                    self._emit_line(wl, base_left + pad, cw, y_top, 'L', scale_mult=0.88)
                    self._line_idx += 1
                if self.code_box and self._line_idx > start_line:
                    self._draw_box(base_left, self._line_y(start_line), avail_base,
                                   (self._line_idx - start_line) * self.line_h)
                if self._line_idx >= self.line_num:
                    self._new_page()
                continue

            if isinstance(blk, MathBlock):
                em = self.line_h * self.text_size * 1.35 * self.math_scale
                mpaths, mw, mh, _mb = render_latex_paths(blk.latex, em)
                if mw > avail_base and mw > 0:
                    s = avail_base / mw
                    for mp in mpaths:
                        mp.transform(Affine2D().scale(s, s))
                    mw *= s
                    mh *= s
                needed = max(1, int(math.ceil(mh / self.line_h)))
                needed = min(needed, self.line_num)
                self._ensure_lines(needed)
                y_top = self._line_y()
                x_off = base_left + max(0.0, (avail_base - mw) * 0.5)
                y_off = y_top + max(0.0, (needed * self.line_h - mh) * 0.5)
                for mp in mpaths:
                    mp.transform(Affine2D().translate(x_off, y_off))
                    self._cur_page.append(mp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, ChartBlock):
                needed = max(3, min(self.line_num, int(blk.spec.get('lines') or self.chart_lines)))
                self._ensure_lines(needed)
                y_top = self._line_y()
                ch_h = needed * self.line_h - 1.5
                def _chart_text(t: str, tx: float, ty: float, th: float, al: str) -> float:
                    return self.draw_text_string(t, base_left + tx, y_top + ty, th, al)
                cpaths = render_chart_paths(blk.spec, avail_base, ch_h,
                                            self.line_h * self.text_size, _chart_text)
                for cp in cpaths:
                    cp.transform(Affine2D().translate(base_left, y_top))
                    self._cur_page.append(cp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, SvgBlock):
                max_lines = min(self.line_num, self.chart_lines)
                spaths, sw, sh = render_svg_paths(
                    blk.svg, avail_base, max_lines * self.line_h,
                    font_for=lambda _fams: self.font,
                    fonts_set=self.fs, rng=self.rng, missing=self.missing,
                    missing_glyph=self.missing_glyph,
                )
                needed = max(1, min(self.line_num, int(math.ceil(sh / self.line_h))))
                self._ensure_lines(needed)
                y_top = self._line_y()
                x_off = base_left + max(0.0, (avail_base - sw) * 0.5)
                y_off = y_top + max(0.0, (needed * self.line_h - sh) * 0.5)
                for sp in spaths:
                    sp.transform(Affine2D().translate(x_off, y_off))
                    self._cur_page.append(sp)
                self._advance_lines(needed)
                continue

            if isinstance(blk, TableBlock):
                self._layout_table(blk, base_left, avail_base)
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

    def _layout_table(self, tbl: TableBlock, x0: float, avail_w: float):
        ncols = max(len(tbl.headers), max((len(r) for r in tbl.rows), default=0))
        if ncols <= 0:
            return
        col_w = avail_w / ncols
        pad_x = 1.5
        inner_w = max(4.0, col_w - pad_x * 2)

        def prepare_row(cells: list[list[Inline]], is_hdr: bool) -> list[list[list[_RichItem]]]:
            wrapped_cols = []
            for ci in range(ncols):
                runs = cells[ci] if ci < len(cells) else []
                wrapped_cols.append(self._runs_to_wrapped_lines(runs, inner_w, inner_w,
                                                                scale_mult=0.92, force_bold=is_hdr))
            return wrapped_cols

        hdr_wrapped = prepare_row(tbl.headers, True) if tbl.headers else None
        all_rows = ([('hdr', hdr_wrapped)] if hdr_wrapped else []) + \
                   [('row', prepare_row(r, False)) for r in tbl.rows]

        def draw_row(wrapped_cols: list[list[list[_RichItem]]], is_hdr: bool):
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
            # Draw cell borders
            box = Path()
            box.rect(x0, y_row_top, avail_w, row_h)
            self._cur_page.append(box)
            for ci in range(1, ncols):
                vx = x0 + ci * col_w
                vp = Path()
                vp.move_to(vx, y_row_top)
                vp.line_to(vx, y_row_top + row_h)
                self._cur_page.append(vp)
            if is_hdr:
                hp = Path()
                hp.move_to(x0, y_row_top + row_h - 0.35)
                hp.line_to(x0 + avail_w, y_row_top + row_h - 0.35)
                self._cur_page.append(hp)

        for kind, wcols in all_rows:
            needed = max(1, max(len(wc) for wc in wcols))
            if self._line_idx > 0 and self._line_idx + needed > self.line_num:
                self._new_page()
                if kind == 'row' and hdr_wrapped and self.table_header_repeat:
                    h_need = max(1, max(len(wc) for wc in hdr_wrapped))
                    if self._line_idx + h_need + needed <= self.line_num:
                        draw_row(hdr_wrapped, True)
            draw_row(wcols, kind == 'hdr')
            if self._line_idx >= self.line_num:
                self._new_page()

    # ------------------------------------------------------------------ public API

    def layout_and_render(self, content: str, fmt_name: str = 'markdown',
                          para_fmt: Optional[ParagraphFormat] = None,
                          align: str = 'L') -> list[list[Path]]:
        """Parse rich content and lay it out into per-page Path lists (mm, y-down)."""
        self._reset_pages()
        blocks = parse_rich(content, fmt_name)
        self._layout_blocks(blocks, para_fmt or ParagraphFormat(), align)
        # Drop trailing empty page if previous pages exist
        while len(self._pages) > 1 and not self._pages[-1]:
            self._pages.pop()
        return self._pages or [[]]
