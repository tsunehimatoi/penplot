"""Internal ordered-path emission with statistics from the emitted decimals.

Only the closed GRBL Servo/Laser/Stepper command vocabulary is accelerated. Unknown
profiles/commands use the public analyzer, including its warnings and safety
checks. The public generator and analyzer remain independent references.
"""
import math
from array import array

from .gcode import GcodeAnalysis, GcodeBuilder, analyze_gcode, _java_float
from .geometry import MOVE


class _StatisticsBuffer(list):
    """Observe writer fragments, without tokenizing the complete file again."""

    def __init__(self, machine):
        super().__init__()
        s = machine.settings
        self.valid = True
        self.x = self.y = self.z = 0.0
        self.zmin = self.zmax = 0.0
        self.z_down, self.z_up = machine.grbl.zOn, machine.grbl.zOff
        self.pen = False
        self.feed = s.feedRate
        self.rapid = s.jogSpeed
        self.lines = self.motion_lines = self.lifts = 0
        self.total = self.draw = self.travel = 0.0
        self.bounds = [math.inf, math.inf, -math.inf, -math.inf]
        self.travel_bounds = [math.inf, math.inf, -math.inf, -math.inf]
        self.controls = {'G21\r\n': ('noop', 0), 'G90\r\n': ('noop', 0),
                         'F%d\r\n' % s.feedRate: ('feed', float('%d' % s.feedRate))}
        g = machine.grbl
        if g.type == 'Stepper':
            for z in (g.zOff, g.zOn):
                literal = _java_float(z)
                if 'e' in literal.lower() or not math.isfinite(float(literal)):
                    self.valid = False
                self.controls['G1G90 Z%sF%d\r\n' % (literal, g.zSpeed)] = (
                    'z', (float(literal), float('%d' % g.zSpeed)))
        else:
            self.controls.update({'M5\r\n': ('up', 0),
                                  'M3S%d\r\n' % g.laserS: ('down', 0)})
        for delay in (s.toolOnDelay, s.toolOffDelay):
            if delay > 0:
                literal = _java_float(delay)
                # The reference tokenizer does not interpret exponent notation.
                if 'e' in literal.lower() or not math.isfinite(float(literal)):
                    self.valid = False
                self.controls['G4 P%s\r\n' % literal] = ('dwell', float(literal))
        if any(len(line.rstrip()) > 80 for line in self.controls):
            self.valid = False

    @staticmethod
    def _extend(bb, x, y, nx, ny):
        if x < bb[0]: bb[0] = x
        if nx < bb[0]: bb[0] = nx
        if y < bb[1]: bb[1] = y
        if ny < bb[1]: bb[1] = ny
        if x > bb[2]: bb[2] = x
        if nx > bb[2]: bb[2] = nx
        if y > bb[3]: bb[3] = y
        if ny > bb[3]: bb[3] = ny

    def _move(self, nx, ny, rapid, nz=None):
        x, y = self.x, self.y
        has_z = nz is not None
        if not has_z:
            nz = self.z
        dxy = math.hypot(nx - x, ny - y)
        # Preserve the reference's arithmetic order, including sqrt(dxy²).
        dz = abs(nz - self.z)
        d = math.sqrt(dxy * dxy + dz * dz)
        rate = self.rapid if rapid else self.feed
        if rate > 0:
            self.total += d / rate * 60.0
        self.motion_lines += 1
        if has_z:
            down = abs(nz - self.z_down) < abs(nz - self.z_up)
            if self.pen and not down:
                self.lifts += 1
            self.pen = down
        self._extend(self.travel_bounds, x, y, nx, ny)
        if nz < self.zmin:
            self.zmin = nz
        if nz > self.zmax:
            self.zmax = nz
        if dxy > 0:
            if self.pen:
                self.draw += dxy
                self._extend(self.bounds, x, y, nx, ny)
            else:
                self.travel += dxy
        self.x, self.y, self.z = nx, ny, nz

    def append(self, text):
        super().append(text)
        if not self.valid or text == '\r\n':
            return
        self.lines += 1
        action = self.controls.get(text)
        if action is not None:
            kind, value = action
            if kind == 'up':
                self.lifts += int(self.pen)
                self.pen = False
            elif kind == 'down':
                self.pen = True
            elif kind == 'dwell':
                self.total += value
            elif kind == 'feed' and value > 0:
                self.feed = value
            elif kind == 'z':
                z, feed = value
                if feed > 0:
                    self.feed = feed
                self._move(self.x, self.y, False, z)
        elif text == 'G90G0 X0Y0\r\n':
            self._move(0.0, 0.0, True)
        elif text.startswith(('G0 X', 'G1 X')) and len(text) <= 80:
            # These are exact GrblWriter.move fragments, after fmt3 and rotation.
            xy, feed = text[4:].split('F')
            x, y = map(float, xy.split('Y'))
            if not math.isfinite(x) or not math.isfinite(y):
                self.valid = False
                return
            feed = float(feed)
            if feed > 0:
                self.feed = feed
            self._move(x, y, text[1] == '0')
        else:
            self.valid = False

    def analysis(self):
        a = GcodeAnalysis()
        a.times, a.cum = array('d'), array('d')
        a.xs, a.ys, a.zs = array('d'), array('d'), array('d')
        a.pen, a.absolute = array('b'), array('b')
        a.bbox = tuple(self.bounds) if self.bounds[0] != math.inf else None
        a.travel_bbox = tuple(self.travel_bounds) if self.travel_bounds[0] != math.inf else None
        a.z_range = (self.zmin, self.zmax)
        a.draw_mm, a.travel_mm = self.draw, self.travel
        a.pen_lifts = self.lifts + int(self.pen)
        a.lines, a.motion_lines, a.est_s = self.lines, self.motion_lines, self.total
        a.warnings = (['没有检测到落笔移动（笔状态命令不识别？）']
                      if self.motion_lines and self.draw == 0.0 else [])
        a.machine_moves, a.unsafe = [], []
        return a


def generate_analyzed_gcode(paths, machine):
    """Return (G-code, summary analysis) for paths already in export order.

    Read-only traversal matches generate_gcode(optimize=False), including
    ignoring leading LINEs and suppressing repeated unrounded coordinates.
    No clone or second subpath materialization is needed by the writer.
    """
    builder = GcodeBuilder(machine)
    if (machine.type == 'Grbl' and machine.grbl.type in ('Servo', 'Laser', 'Stepper')
            and not machine.advanced.startGcode and not machine.advanced.endGcode):
        try:
            builder.buf = _StatisticsBuffer(machine)
        except (TypeError, ValueError, OverflowError):
            # Do not eagerly reject a setting that this particular job never
            # emits (e.g. an invalid laser power on an empty page).
            pass
    builder.start()
    last_x = last_y = float('nan')
    for path in paths:
        started = False
        for op, x, y in path.iter_points():
            if op == MOVE:
                started = True
            if not started:
                continue
            if x != last_x or y != last_y:
                last_x, last_y = x, y
                if op == MOVE:
                    builder.pen_up()
                    builder.move(x, y, True)
                    builder.pen_down()
                else:
                    builder.move(x, y, False)
    builder.finish()
    text = builder.text()
    buf = builder.buf
    analysis = (buf.analysis() if isinstance(buf, _StatisticsBuffer) and buf.valid
                else analyze_gcode(text, machine, keep_arrays=False))
    return text, analysis
