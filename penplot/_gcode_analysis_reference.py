"""Frozen analyzer before acceleration; differential-test oracle, not production dispatch."""
import math

def analyze_gcode_reference(text, machine=None, rapid_rate=None, keep_arrays=True):
    """Per-line simulation for ETA, retry-from-line and import checks (03 §10.9).

    Times: G0/G1 XY distance / feed (G0 at rapid_rate, default
    settings.jogSpeed), Z moves |dz| / feed, G4 P dwell (seconds, GRBL).
    Pen-down = Z closer to the pen-down height (as parse_gcode) or M3/M4.
    bbox covers pen-down XY moves (machine coords).
    """
    from .gcode import GcodeAnalysis
    import re
    from array import array
    word = re.compile(r'([A-Za-z])\s*([+-]?\d*\.?\d+)')
    if machine is not None and machine.type in ('Marlin', 'K_AT'):
        z_down, z_up = machine.marlin.penDownMM, machine.marlin.penUpMM
    elif machine is not None:
        z_down, z_up = machine.grbl.zOn, machine.grbl.zOff
    else:
        z_down, z_up = 2.0, 0.0
    if rapid_rate is None:
        rapid_rate = machine.settings.jogSpeed if machine is not None else 2500.0
    feed = machine.settings.feedRate if machine is not None else 1500.0
    times = array('d')
    cum = array('d')
    xs, ys, zs = array('d'), array('d'), array('d')
    pen_arr = array('b')
    absa = array('b')
    x = y = z = 0.0
    absolute = True
    motion = 0
    pen = False
    total = 0.0
    draw = travel = 0.0
    lifts = 0
    motion_lines = 0
    minx = miny = float('inf')
    maxx = maxy = float('-inf')
    warnings = []
    warned = set()
    n = 0
    unit = 1.0
    from .machine.base import line_problem, strip_comments
    tminx = tminy = float('inf')
    tmaxx = tmaxy = float('-inf')
    zmin = zmax = 0.0
    machine_moves = []
    unsafe = []

    def warn(key, msg):
        if key not in warned and len(warnings) < 50:
            warned.add(key)
            warnings.append(msg)

    for raw in text.split('\n'):
        s = raw.strip()
        if not s:
            continue
        n += 1
        if len(s) > 80:
            warn('long', '第 %d 行超过 80 个字符（GRBL 行缓冲上限）' % n)
        line = strip_comments(s)
        why = line_problem(line, allow_dollar=False) if line else None
        if why and len(unsafe) < 200:
            unsafe.append((n, why))
        t = 0.0
        if line and not line.startswith(('%', '$')):
            words = []
            for m in word.finditer(line):
                words.append((m.group(1).upper(), float(m.group(2))))
            gs = [int(v) for k, v in words if k == 'G']
            ms = [int(v) for k, v in words if k == 'M']
            vals = {k: v for k, v in words if k not in ('G', 'M')}
            for g in gs:
                if g == 20:
                    unit = 25.4
                elif g == 21:
                    unit = 1.0
            for k in ('X', 'Y', 'Z', 'F'):
                if k in vals:
                    vals[k] *= unit
            for g in gs:
                if g in (0, 1, 2, 3):
                    motion = g
                    if g in (2, 3):
                        warn('arc', 'G2/G3 圆弧按直线估算')
                elif g == 90:
                    absolute = True
                elif g == 91:
                    absolute = False
                    warn('g91', '包含 G91 相对坐标段')
                elif g == 20:
                    unit = 25.4
                    warn('g20', '包含 G20 英制单位：已按英寸换算成毫米')
                elif g == 21:
                    unit = 1.0
                elif g in (28, 30, 53):
                    if len(machine_moves) < 200:
                        machine_moves.append(n)
                    warn('g%d' % g, '包含 G%d（机械坐标/存储位置移动，本机没有回零，位置不可预测）' % g)
                elif g not in (4, 10, 17, 54, 92, 94):
                    warn('g%d' % g, '不支持的 G%d' % g)
            for mc in ms:
                if mc in (3, 4):
                    if not pen:
                        pen = True
                elif mc == 5:
                    if pen:
                        lifts += 1
                    pen = False
                elif mc not in (0, 1, 2, 30, 106, 107, 280, 8, 9):
                    warn('m%d' % mc, '不支持的 M%d' % mc)
            if 'F' in vals and vals['F'] > 0:
                feed = vals['F']
            if 4 in gs:
                t += vals.get('P', 0.0)
            elif not (gs and set(gs) <= {10, 28, 30, 53, 92}):
                has_xy = 'X' in vals or 'Y' in vals
                if has_xy or 'Z' in vals:
                    motion_lines += 1
                    if absolute:
                        nx, ny, nz = vals.get('X', x), vals.get('Y', y), vals.get('Z', z)
                    else:
                        nx, ny, nz = x + vals.get('X', 0.0), y + vals.get('Y', 0.0), z + vals.get('Z', 0.0)
                    rate = rapid_rate if motion == 0 else feed
                    dxy = math.hypot(nx - x, ny - y)
                    dz = abs(nz - z)
                    d = math.sqrt(dxy * dxy + dz * dz)
                    if rate > 0:
                        t += d / rate * 60.0
                    if 'Z' in vals:
                        down = abs(nz - z_down) < abs(nz - z_up)
                        if pen and not down:
                            lifts += 1
                        pen = down
                    for px, py in ((x, y), (nx, ny)):
                        if px < tminx:
                            tminx = px
                        if px > tmaxx:
                            tmaxx = px
                        if py < tminy:
                            tminy = py
                        if py > tmaxy:
                            tmaxy = py
                    if nz < zmin:
                        zmin = nz
                    if nz > zmax:
                        zmax = nz
                    if dxy > 0:
                        if pen:
                            draw += dxy
                            for px, py in ((x, y), (nx, ny)):
                                if px < minx:
                                    minx = px
                                if px > maxx:
                                    maxx = px
                                if py < miny:
                                    miny = py
                                if py > maxy:
                                    maxy = py
                        else:
                            travel += dxy
                    x, y, z = nx, ny, nz
        total += t
        if keep_arrays:
            times.append(t)
            cum.append(total)
            xs.append(x)
            ys.append(y)
            zs.append(z)
            pen_arr.append(1 if pen else 0)
            absa.append(1 if absolute else 0)
    if pen:
        lifts += 1
    if motion_lines and draw == 0.0:
        warn('nopen', '没有检测到落笔移动（笔状态命令不识别？）')
    a = GcodeAnalysis()
    a.times, a.cum, a.xs, a.ys, a.zs, a.pen, a.absolute = times, cum, xs, ys, zs, pen_arr, absa
    a.bbox = (minx, miny, maxx, maxy) if minx != float('inf') else None
    a.draw_mm, a.travel_mm, a.pen_lifts = draw, travel, lifts
    a.lines, a.motion_lines, a.est_s = n, motion_lines, total
    a.warnings = warnings
    a.travel_bbox = (tminx, tminy, tmaxx, tmaxy) if tminx != float('inf') else None
    a.z_range = (zmin, zmax)
    a.machine_moves = machine_moves
    a.unsafe = unsafe
    if unsafe:
        warn('unsafe', '%d 行含有不能发送的内容（实时控制字符、非 ASCII 或 $ 命令），已拒绝' % len(unsafe))
    return a
