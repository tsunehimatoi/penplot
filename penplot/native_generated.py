"""ctypes bridge to the optional Rust GRBL Stepper generator.

CDLL releases the GIL for the entire native emission/statistics call. Packing
Python paths and decoding the result still hold the GIL. No runtime build.
"""
import ctypes as ct
import math
import os
import sys
from array import array
from functools import lru_cache
from pathlib import Path


class _Result(ct.Structure):
    _fields_ = [('text', ct.c_void_p), ('length', ct.c_size_t),
                ('values', ct.c_double * 13), ('counts', ct.c_uint64 * 3)]


@lru_cache(maxsize=1)
def _load():
    name = ('penplot_generated.dll' if sys.platform == 'win32' else
            'libpenplot_generated.dylib' if sys.platform == 'darwin' else 'libpenplot_generated.so')
    path = Path(__file__).with_name('_native_generated') / name
    try:
        lib = ct.CDLL(str(path))
        lib.penplot_generated_abi.argtypes = []
        lib.penplot_generated_abi.restype = ct.c_uint32
        if lib.penplot_generated_abi() != 1:
            return None
        lib.penplot_generate.argtypes = [ct.POINTER(ct.c_double), ct.POINTER(ct.c_uint8), ct.c_size_t,
            ct.POINTER(ct.c_uint64), ct.c_size_t, ct.POINTER(ct.c_double),
            ct.POINTER(ct.c_char_p), ct.POINTER(ct.c_size_t)]
        lib.penplot_generate.restype = ct.POINTER(_Result)
        lib.penplot_generated_free.argtypes = [ct.POINTER(_Result)]
        lib.penplot_generated_free.restype = None
        return lib
    except (OSError, AttributeError):
        return None


def native_available():
    """Whether the compiled, ABI-compatible library is installed and enabled."""
    return os.environ.get('PENPLOT_NATIVE_GENERATION', '1') != '0' and _load() is not None


def try_generate(paths, machine):
    """Return (text, analysis), or None for unsupported settings/input/library.

    The native subset is deliberately narrow: Stepper, positive integral
    rates, no custom commands, no generator rotation, no dwell. Origin/page
    transforms have already happened before this interface is called.
    """
    s, g = machine.settings, machine.grbl
    if (machine.type != 'Grbl' or g.type != 'Stepper' or s.rotate
            or machine.advanced.startGcode or machine.advanced.endGcode
            or s.toolOnDelay != 0 or s.toolOffDelay != 0 or not native_available()):
        return None
    from .gcode import GcodeAnalysis, GrblWriter, _java_float
    try:
        rates = [float(s.feedRate), float(s.jogSpeed), float(g.zSpeed)]
        if any(not math.isfinite(v) or v != int(v) or not 0 < v <= 1e9 for v in rates):
            return None
        heights = [_java_float(g.zOn), _java_float(g.zOff)]
        if any('e' in v.lower() for v in heights):
            return None
        heights = list(map(float, heights))
        if any(not math.isfinite(v) or abs(v) > 1e9 for v in heights):
            return None
        xy, ops, offsets = array('d'), array('B'), array('Q', [0])
        for path in paths:
            if len(path.coords) != 2 * len(path.ops):
                return None
            xy.extend(path.coords)
            ops.extend(path.ops)
            offsets.append(len(ops))
        writer = GrblWriter(machine)
        chunks = []
        for emit in (writer.start, writer.pen_up, writer.pen_down, writer.finish):
            buffer = []
            emit(buffer)
            chunks.append(''.join(buffer).encode('ascii'))
    except (TypeError, ValueError, OverflowError):
        return None
    # from_buffer holds a live reference and borrows the contiguous array;
    # neither caller nor native code mutates these call-local input buffers.
    xy_buffer = (ct.c_double * len(xy)).from_buffer(xy)
    op_buffer = (ct.c_uint8 * len(ops)).from_buffer(ops)
    offset_buffer = (ct.c_uint64 * len(offsets)).from_buffer(offsets)
    config = (ct.c_double * 5)(*rates, *heights)
    buffers = (ct.c_char_p * 4)(*chunks)
    lengths = (ct.c_size_t * 4)(*(len(chunk) for chunk in chunks))
    lib = _load()
    result = lib.penplot_generate(xy_buffer, op_buffer, len(ops), offset_buffer,
                                 len(offsets) - 1, config, buffers, lengths)
    if not result:
        return None
    try:
        data = result.contents
        text = ct.string_at(data.text, data.length).decode('ascii')
        values, counts = list(data.values), list(data.counts)
    finally:
        lib.penplot_generated_free(result)
    analysis = GcodeAnalysis()
    analysis.times, analysis.cum = array('d'), array('d')
    analysis.xs, analysis.ys, analysis.zs = array('d'), array('d'), array('d')
    analysis.pen, analysis.absolute = array('b'), array('b')
    analysis.draw_mm, analysis.travel_mm, analysis.est_s = values[:3]
    analysis.bbox = tuple(values[3:7]) if values[3] != math.inf else None
    analysis.travel_bbox = tuple(values[7:11]) if values[7] != math.inf else None
    analysis.z_range = tuple(values[11:13])
    analysis.lines, analysis.motion_lines, analysis.pen_lifts = counts
    analysis.warnings = (['没有检测到落笔移动（笔状态命令不识别？）']
                         if analysis.motion_lines and analysis.draw_mm == 0 else [])
    analysis.machine_moves, analysis.unsafe = [], []
    return text, analysis
