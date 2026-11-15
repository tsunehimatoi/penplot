# -*- coding: utf-8 -*-
"""Vector renderers for LaTeX formulas, charts, and inline SVGs in rich text.

All text inside charts and SVGs uses the user's selected stroke font via
callbacks, and all geometry is returned as penplot.geometry.Path in mm (y-down).
"""
from __future__ import annotations

import ast
import math
import os
import tempfile
from typing import Any, Callable, Optional

from .geometry import Path, bbox_of, scale_all, translate_all

# Callback: (text, x_mm, y_baseline_mm, font_h_mm, align) -> width_mm
DrawTextFn = Callable[[str, float, float, float, str], float]


# ------------------------------------------------------------------ LaTeX -> Path

def _flatten_quad(p0, p1, p2, tol=0.05, depth=0):
    if depth >= 6:
        return [p2]
    mx = 0.25 * p0[0] + 0.5 * p1[0] + 0.25 * p2[0]
    my = 0.25 * p0[1] + 0.5 * p1[1] + 0.25 * p2[1]
    lx = 0.5 * (p0[0] + p2[0])
    ly = 0.5 * (p0[1] + p2[1])
    if math.hypot(mx - lx, my - ly) <= tol:
        return [p2]
    p01 = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
    p12 = ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)
    pm = ((p01[0] + p12[0]) * 0.5, (p01[1] + p12[1]) * 0.5)
    return _flatten_quad(p0, p01, pm, tol, depth + 1) + _flatten_quad(pm, p12, p2, tol, depth + 1)


def _flatten_cubic(p0, p1, p2, p3, tol=0.05, depth=0):
    if depth >= 6:
        return [p3]
    dx = p3[0] - p0[0]
    dy = p3[1] - p0[1]
    d2 = abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx)
    d3 = abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx)
    if (d2 + d3) ** 2 <= tol * tol * (dx * dx + dy * dy + 1e-9) * 16.0:
        return [p3]
    p01 = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
    p12 = ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)
    p23 = ((p2[0] + p3[0]) * 0.5, (p2[1] + p3[1]) * 0.5)
    p012 = ((p01[0] + p12[0]) * 0.5, (p01[1] + p12[1]) * 0.5)
    p123 = ((p12[0] + p23[0]) * 0.5, (p12[1] + p23[1]) * 0.5)
    pm = ((p012[0] + p123[0]) * 0.5, (p012[1] + p123[1]) * 0.5)
    return _flatten_cubic(p0, p01, p012, pm, tol, depth + 1) + _flatten_cubic(pm, p123, p23, p3, tol, depth + 1)


def render_latex_paths(latex: str, em_mm: float,
                       fallback_text_fn: Optional[DrawTextFn] = None
                       ) -> tuple[list[Path], float, float, float]:
    """Render a LaTeX math string to penplot Paths (top-left at 0,0, y-down).

    Returns (paths, width_mm, height_mm, baseline_y_mm).
    """
    tex = latex.strip()
    if not tex:
        return [], 0.0, em_mm, em_mm * 0.75
    try:
        from matplotlib.font_manager import FontProperties
        from matplotlib.path import Path as MplPath
        from matplotlib.textpath import TextToPath

        ttp = TextToPath()
        # Use a fixed pt size (12pt) then scale cleanly to em_mm
        verts, codes = ttp.get_text_path(FontProperties(size=12.0), f'${tex}$', ismath=True)
        if not len(verts):
            return [], 0.0, em_mm, em_mm * 0.75

        # Convert matplotlib path (y-up, ~12 units per em) to penplot Paths (y-down, mm)
        scale = em_mm / 10.5
        out: list[Path] = []
        cur_path: Optional[Path] = None
        start_pt = (0.0, 0.0)
        cur_pt = (0.0, 0.0)
        i = 0
        n = len(codes)
        while i < n:
            c = codes[i]
            if c == MplPath.MOVETO:
                if cur_path is not None and len(cur_path.coords) >= 4:
                    out.append(cur_path)
                cur_path = Path()
                pt = (float(verts[i][0]) * scale, -float(verts[i][1]) * scale)
                cur_path.move_to(pt[0], pt[1])
                start_pt = cur_pt = pt
                i += 1
            elif c == MplPath.LINETO:
                if cur_path is None:
                    cur_path = Path()
                    cur_path.move_to(cur_pt[0], cur_pt[1])
                pt = (float(verts[i][0]) * scale, -float(verts[i][1]) * scale)
                cur_path.line_to(pt[0], pt[1])
                cur_pt = pt
                i += 1
            elif c == MplPath.CURVE3 and i + 1 < n:
                if cur_path is None:
                    cur_path = Path()
                    cur_path.move_to(cur_pt[0], cur_pt[1])
                p1 = (float(verts[i][0]) * scale, -float(verts[i][1]) * scale)
                p2 = (float(verts[i + 1][0]) * scale, -float(verts[i + 1][1]) * scale)
                for q in _flatten_quad(cur_pt, p1, p2, tol=0.04):
                    cur_path.line_to(q[0], q[1])
                cur_pt = p2
                i += 2
            elif c == MplPath.CURVE4 and i + 2 < n:
                if cur_path is None:
                    cur_path = Path()
                    cur_path.move_to(cur_pt[0], cur_pt[1])
                p1 = (float(verts[i][0]) * scale, -float(verts[i][1]) * scale)
                p2 = (float(verts[i + 1][0]) * scale, -float(verts[i + 1][1]) * scale)
                p3 = (float(verts[i + 2][0]) * scale, -float(verts[i + 2][1]) * scale)
                for q in _flatten_cubic(cur_pt, p1, p2, p3, tol=0.04):
                    cur_path.line_to(q[0], q[1])
                cur_pt = p3
                i += 3
            elif c == MplPath.CLOSEPOLY:
                if cur_path is not None and len(cur_path.coords) >= 4:
                    cur_path.line_to(start_pt[0], start_pt[1])
                    out.append(cur_path)
                    cur_path = None
                cur_pt = start_pt
                i += 1
            else:
                i += 1
        if cur_path is not None and len(cur_path.coords) >= 4:
            out.append(cur_path)

        bb = bbox_of(out)
        if bb is None:
            return [], 0.0, em_mm, em_mm * 0.75
        # Shift so min_x=0, min_y=0; track where y=0 (the math baseline) landed
        dx = -bb[0]
        dy = -bb[1]
        translate_all(out, dx, dy)
        return out, bb[2] - bb[0], bb[3] - bb[1], dy
    except Exception:
        # Graceful fallback: draw raw text in the selected stroke font
        if fallback_text_fn is not None:
            w = fallback_text_fn(tex, 0.0, em_mm * 0.75, em_mm, 'L')
            return [], w, em_mm, em_mm * 0.75
        return [], em_mm * 0.5 * len(tex), em_mm, em_mm * 0.75


# ------------------------------------------------------------------ Safe function evaluator for function plots

_MATH_ENV: dict[str, Any] = {
    'sin': math.sin, 'cos': math.cos, 'tan': math.tan,
    'asin': math.asin, 'acos': math.acos, 'atan': math.atan,
    'sinh': math.sinh, 'cosh': math.cosh, 'tanh': math.tanh,
    'exp': math.exp, 'log': math.log, 'log10': math.log10,
    'sqrt': math.sqrt, 'abs': abs, 'floor': math.floor, 'ceil': math.ceil,
    'pi': math.pi, 'e': math.e,
}


def _eval_math_ast(node: ast.AST, x_val: float) -> float:
    if isinstance(node, ast.Expression):
        return _eval_math_ast(node.body, x_val)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id == 'x':
            return x_val
        if node.id in _MATH_ENV and isinstance(_MATH_ENV[node.id], (int, float)):
            return float(_MATH_ENV[node.id])
        raise ValueError(f'Unknown symbol: {node.id}')
    if isinstance(node, ast.UnaryOp):
        v = _eval_math_ast(node.operand, x_val)
        if isinstance(node.op, ast.UAdd):
            return v
        if isinstance(node.op, ast.USub):
            return -v
        raise ValueError('Unsupported unary op')
    if isinstance(node, ast.BinOp):
        a = _eval_math_ast(node.left, x_val)
        b = _eval_math_ast(node.right, x_val)
        if isinstance(node.op, ast.Add):
            return a + b
        if isinstance(node.op, ast.Sub):
            return a - b
        if isinstance(node.op, ast.Mult):
            return a * b
        if isinstance(node.op, ast.Div):
            return a / b
        if isinstance(node.op, ast.Pow):
            return a ** b
        if isinstance(node.op, ast.Mod):
            return a % b
        raise ValueError('Unsupported binary op')
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        fn = _MATH_ENV.get(node.func.id)
        if callable(fn) and len(node.args) == 1 and not node.keywords:
            return float(fn(_eval_math_ast(node.args[0], x_val)))
    raise ValueError('Unsupported expression')


# ------------------------------------------------------------------ Vector Chart Renderer

def _nice_ticks(vmin: float, vmax: float, count: int = 5) -> list[float]:
    if vmin == vmax:
        return [vmin - 1.0, vmin, vmin + 1.0]
    span = vmax - vmin
    raw_step = span / max(1, count - 1)
    mag = 10.0 ** math.floor(math.log10(raw_step))
    norm = raw_step / mag
    if norm <= 1.5:
        step = 1.0 * mag
    elif norm <= 3.0:
        step = 2.0 * mag
    elif norm <= 7.0:
        step = 5.0 * mag
    else:
        step = 10.0 * mag
    lo = math.floor(vmin / step) * step
    hi = math.ceil(vmax / step) * step
    ticks = []
    cur = lo
    while cur <= hi + step * 1e-6 and len(ticks) < 20:
        ticks.append(round(cur, 10))
        cur += step
    return ticks


def _fmt_num(v: float) -> str:
    if abs(v - round(v)) < 1e-6:
        return str(int(round(v)))
    return f'{v:.2g}'


def _marker_path(cx: float, cy: float, r: float, kind: int) -> Path:
    p = Path()
    k = kind % 4
    if k == 0:  # circle
        for i in range(13):
            a = i * math.tau / 12
            px, py = cx + r * math.cos(a), cy + r * math.sin(a)
            p.move_to(px, py) if i == 0 else p.line_to(px, py)
    elif k == 1:  # square
        p.rect(cx - r, cy - r, r * 2, r * 2)
    elif k == 2:  # diamond
        p.move_to(cx, cy - r * 1.2)
        p.line_to(cx + r * 1.2, cy)
        p.line_to(cx, cy + r * 1.2)
        p.line_to(cx - r * 1.2, cy)
        p.line_to(cx, cy - r * 1.2)
    else:  # cross / X
        p.move_to(cx - r, cy - r)
        p.line_to(cx + r, cy + r)
        p.move_to(cx + r, cy - r)
        p.line_to(cx - r, cy + r)
    return p


def _hatch_rect(x0: float, y0: float, w: float, h: float, spacing: float) -> list[Path]:
    """45-degree diagonal hatch lines inside a rectangle (for bar/area differentiation)."""
    if w <= 0 or h <= 0 or spacing <= 0:
        return []
    out: list[Path] = []
    d = spacing
    while d < w + h:
        x_start = x0 + max(0.0, d - h)
        y_start = y0 + min(h, d)
        x_end = x0 + min(w, d)
        y_end = y0 + max(0.0, d - w)
        p = Path()
        p.move_to(x_start, y_start)
        p.line_to(x_end, y_end)
        out.append(p)
        d += spacing
    return out


def render_chart_paths(spec: dict[str, Any], width_mm: float, height_mm: float,
                       text_h_mm: float, draw_text: DrawTextFn) -> list[Path]:
    """Render a chart spec to vector penplot Paths in [0..width_mm, 0..height_mm]."""
    paths: list[Path] = []
    ctype = str(spec.get('type', 'bar')).lower()
    title = str(spec.get('title') or '')
    label_h = min(max(2.2, text_h_mm * 0.72), 4.0)
    title_h = min(max(2.8, text_h_mm * 0.95), 5.5)

    top_pad = (title_h + 3.0) if title else 2.0
    if title:
        draw_text(title, width_mm * 0.5, title_h * 0.85, title_h, 'C')

    series = spec.get('series') or []
    # Normalize simple `data: [...]` into single series
    if not series and isinstance(spec.get('data'), list):
        series = [{'name': spec.get('name', ''), 'data': spec['data']}]

    # Pie chart
    if ctype == 'pie':
        data = series[0].get('data', []) if series else []
        labels = [str(x) for x in (spec.get('x') or spec.get('labels') or [f'#{i+1}' for i in range(len(data))])]
        vals = [max(0.0, float(v)) for v in data]
        total = sum(vals)
        if total <= 0:
            return paths
        cx = width_mm * 0.42
        cy = top_pad + (height_mm - top_pad) * 0.5
        r = max(5.0, min(width_mm * 0.28, (height_mm - top_pad) * 0.42))
        circle = Path()
        for i in range(65):
            a = i * math.tau / 64
            px, py = cx + r * math.cos(a), cy + r * math.sin(a)
            circle.move_to(px, py) if i == 0 else circle.line_to(px, py)
        paths.append(circle)
        ang = -math.pi * 0.5
        leg_y = top_pad + label_h * 1.5
        for idx, val in enumerate(vals):
            sweep = (val / total) * math.tau
            p = Path()
            p.move_to(cx, cy)
            p.line_to(cx + r * math.cos(ang), cy + r * math.sin(ang))
            paths.append(p)
            mid = ang + sweep * 0.5
            pct = f'{val / total * 100:.1f}%'
            lbl = labels[idx] if idx < len(labels) else f'#{idx+1}'
            # Callout outside pie or legend on the right
            lx = cx + (r + 3.0) * math.cos(mid)
            ly = cy + (r + 3.0) * math.sin(mid)
            draw_text(pct, lx, ly + label_h * 0.35, label_h * 0.9, 'C')
            # Legend on right side
            leg_x = width_mm * 0.72
            if leg_y < height_mm - 2.0:
                draw_text(f'{lbl}: {pct}', leg_x, leg_y, label_h, 'L')
                leg_y += label_h * 1.45
            ang += sweep
        return paths

    # Function plot
    if ctype in ('function', 'formula'):
        expr = str(spec.get('expr') or spec.get('formula') or 'sin(x)')
        xmin = float(spec.get('xmin', -6.28))
        xmax = float(spec.get('xmax', 6.28))
        samples = max(40, min(400, int(spec.get('samples', 160))))
        try:
            tree = ast.parse(expr, mode='eval')
        except Exception:
            draw_text(f'公式错误: {expr}', width_mm * 0.5, height_mm * 0.5, label_h, 'C')
            return paths
        pts: list[tuple[float, float]] = []
        for s_i in range(samples + 1):
            xv = xmin + (xmax - xmin) * s_i / samples
            try:
                yv = _eval_math_ast(tree, xv)
                if math.isfinite(yv):
                    pts.append((xv, yv))
            except Exception:
                continue
        if len(pts) < 2:
            return paths
        series = [{'name': f'y={expr}', 'xy': pts}]
        ctype = 'scatter_line'

    # Cartesian plot (bar, line, area, scatter, scatter_line)
    has_legend = len(series) > 1 or (len(series) == 1 and bool(series[0].get('name')))
    bot_pad = label_h * 2.2 + (label_h * 1.4 if spec.get('xlabel') else 0.0)
    left_pad = 14.0
    right_pad = 4.0
    if has_legend:
        top_pad += label_h * 1.6

    pw = max(10.0, width_mm - left_pad - right_pad)
    ph = max(10.0, height_mm - top_pad - bot_pad)
    px0, py0 = left_pad, top_pad
    px1, py1 = px0 + pw, py0 + ph

    # Determine Y range
    all_y: list[float] = []
    all_x: list[float] = []
    for s in series:
        if 'xy' in s:
            for xv, yv in s['xy']:
                all_x.append(float(xv))
                all_y.append(float(yv))
        else:
            for yv in s.get('data') or []:
                all_y.append(float(yv))
    if not all_y:
        return paths

    ymin = min(0.0, min(all_y)) if ctype in ('bar', 'area') else min(all_y)
    ymax = max(all_y)
    if ymax == ymin:
        ymax = ymin + 1.0
    yticks = _nice_ticks(ymin, ymax, 5)
    y_lo, y_hi = yticks[0], yticks[-1]
    if y_hi == y_lo:
        y_hi = y_lo + 1.0

    def map_y(val: float) -> float:
        return py1 - (val - y_lo) / (y_hi - y_lo) * ph

    # Axes & horizontal gridlines
    ax = Path()
    ax.move_to(px0, py0)
    ax.line_to(px0, py1)
    ax.line_to(px1, py1)
    paths.append(ax)

    for yt in yticks:
        yy = map_y(yt)
        g = Path()
        g.move_to(px0 - 1.2, yy)
        g.line_to(px0, yy)
        paths.append(g)
        # faint dashed/short grid tick or full light line
        gl = Path()
        gl.move_to(px0, yy)
        gl.line_to(px1, yy)
        paths.append(gl)
        draw_text(_fmt_num(yt), px0 - 2.0, yy + label_h * 0.35, label_h * 0.85, 'R')

    # Legend
    if has_legend:
        lx = px0
        ly = top_pad - label_h * 0.5
        for si, s in enumerate(series):
            nm = str(s.get('name') or f'S{si+1}')
            paths.append(_marker_path(lx + 1.8, ly - label_h * 0.3, 1.1, si))
            w_txt = draw_text(nm, lx + 4.0, ly, label_h * 0.85, 'L')
            lx += max(12.0, w_txt + 8.0)

    # Scatter / function with explicit XY
    if ctype in ('scatter', 'scatter_line'):
        xmin = min(all_x) if all_x else 0.0
        xmax = max(all_x) if all_x else 1.0
        xticks = _nice_ticks(xmin, xmax, 5)
        x_lo, x_hi = xticks[0], xticks[-1]
        if x_hi == x_lo:
            x_hi = x_lo + 1.0
        map_x = lambda v: px0 + (v - x_lo) / (x_hi - x_lo) * pw
        for xt in xticks:
            xx = map_x(xt)
            t = Path()
            t.move_to(xx, py1)
            t.line_to(xx, py1 + 1.2)
            paths.append(t)
            draw_text(_fmt_num(xt), xx, py1 + label_h * 1.3, label_h * 0.85, 'C')
        for si, s in enumerate(series):
            pts = s.get('xy') or [(i, v) for i, v in enumerate(s.get('data') or [])]
            if ctype == 'scatter_line' and len(pts) >= 2:
                lp = Path()
                for pi_idx, (xv, yv) in enumerate(pts):
                    sx, sy = map_x(float(xv)), map_y(float(yv))
                    lp.move_to(sx, sy) if pi_idx == 0 else lp.line_to(sx, sy)
                paths.append(lp)
            else:
                for xv, yv in pts:
                    paths.append(_marker_path(map_x(float(xv)), map_y(float(yv)), 1.0, si))
        return paths

    # Category-based bar / line / area
    n_cats = max((len(s.get('data') or []) for s in series), default=0)
    if n_cats == 0:
        return paths
    x_labels = [str(x) for x in (spec.get('x') or spec.get('labels') or [str(i + 1) for i in range(n_cats)])]
    step_x = pw / n_cats

    # X labels
    label_stride = max(1, int(math.ceil(n_cats / max(1, int(pw / 14.0)))))
    for ci in range(n_cats):
        cx = px0 + (ci + 0.5) * step_x
        tk = Path()
        tk.move_to(cx, py1)
        tk.line_to(cx, py1 + 1.2)
        paths.append(tk)
        if ci % label_stride == 0 and ci < len(x_labels):
            draw_text(x_labels[ci], cx, py1 + label_h * 1.3, label_h * 0.85, 'C')

    if ctype == 'bar':
        n_ser = max(1, len(series))
        group_w = step_x * 0.72
        bar_w = group_w / n_ser
        y_zero = map_y(0.0) if y_lo <= 0.0 <= y_hi else py1
        for si, s in enumerate(series):
            data = s.get('data') or []
            for ci, val in enumerate(data):
                v = float(val)
                bx = px0 + ci * step_x + (step_x - group_w) * 0.5 + si * bar_w
                yv = map_y(v)
                top_y = min(yv, y_zero)
                bh = abs(y_zero - yv)
                if bh < 0.2:
                    bh = 0.2
                rect = Path()
                rect.rect(bx, top_y, bar_w * 0.92, bh)
                paths.append(rect)
                if si > 0:
                    paths.extend(_hatch_rect(bx, top_y, bar_w * 0.92, bh, 1.6 + si * 0.6))
    else:  # line or area
        y_zero = map_y(0.0) if y_lo <= 0.0 <= y_hi else py1
        for si, s in enumerate(series):
            data = s.get('data') or []
            if not data:
                continue
            lp = Path()
            pts_xy = []
            for ci, val in enumerate(data):
                cx = px0 + (ci + 0.5) * step_x
                cy = map_y(float(val))
                pts_xy.append((cx, cy))
                lp.move_to(cx, cy) if ci == 0 else lp.line_to(cx, cy)
            paths.append(lp)
            for cx, cy in pts_xy:
                paths.append(_marker_path(cx, cy, 0.9, si))
            if ctype == 'area' and len(pts_xy) >= 2:
                ap = Path()
                ap.move_to(pts_xy[0][0], y_zero)
                for cx, cy in pts_xy:
                    ap.line_to(cx, cy)
                ap.line_to(pts_xy[-1][0], y_zero)
                paths.append(ap)

    return paths


# ------------------------------------------------------------------ Inline SVG -> Path

def render_svg_paths(svg_str: str, max_w_mm: float, max_h_mm: float,
                     font_for: Callable[[list[str]], Any],
                     fonts_set: Any = None, rng: Any = None,
                     missing: Optional[set] = None,
                     missing_glyph: str = 'box') -> tuple[list[Path], float, float]:
    """Parse an inline <svg> string into penplot Paths fitted into (max_w_mm, max_h_mm)."""
    from .importers.svg import load_svg

    fd, tmp_path = tempfile.mkstemp(suffix='.svg')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(svg_str)
        text_opts = {
            'mode': 'font',
            'font_for': font_for,
            'size_scale': 1.0,
            'fonts_set': fonts_set,
            'rng': rng,
            'missing': missing if missing is not None else set(),
            'messages': [],
            'missing_glyph': missing_glyph,
        }
        paths, _info = load_svg(tmp_path, tol_mm=0.1, text=text_opts)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    bb = bbox_of(paths)
    if bb is None:
        return [], 0.0, 0.0
    translate_all(paths, -bb[0], -bb[1])
    w = max(1e-3, bb[2] - bb[0])
    h = max(1e-3, bb[3] - bb[1])
    s = min(1.0, max_w_mm / w, max_h_mm / h)
    if s < 1.0:
        scale_all(paths, s, s)
        w *= s
        h *= s
    return paths, w, h
