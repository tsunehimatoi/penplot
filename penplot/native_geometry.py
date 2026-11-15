"""Optional page-batched geometry; no runtime compilation or per-glyph FFI.

Buffers use interleaved doubles and uint64 point offsets. A PackedPaths-like
owner is borrowed without copying. Ordinary list coordinates stay in Python:
packing and validating them costs more than the kernel saves. Array-backed
paths can be packed once; shared containers retain sequential Python mutation.
"""
import ctypes as ct
import os
import sys
from array import array
from functools import lru_cache
from pathlib import Path

UNSUPPORTED = object()
MIN_COORDS = 1024


@lru_cache(maxsize=1)
def _load():
    name = ('penplot_generated.dll' if sys.platform == 'win32' else
            'libpenplot_generated.dylib' if sys.platform == 'darwin' else 'libpenplot_generated.so')
    location = os.environ.get('PENPLOT_NATIVE_GEOMETRY_LIBRARY')
    try:
        lib = ct.CDLL(location or str(Path(__file__).with_name('_native_generated') / name))
        lib.penplot_geometry_abi.restype = ct.c_uint32
        lib.penplot_geometry_abi.argtypes = []
        if lib.penplot_geometry_abi() != 1:
            return None
        doubles, offsets = ct.POINTER(ct.c_double), ct.POINTER(ct.c_uint64)
        lib.penplot_geometry_transform.argtypes = [doubles, ct.c_size_t, doubles, ct.c_size_t]
        lib.penplot_geometry_transform.restype = None
        lib.penplot_geometry_bbox.argtypes = [doubles, ct.c_size_t, offsets, ct.c_size_t, doubles]
        lib.penplot_geometry_bbox.restype = ct.c_uint32
        return lib
    except (OSError, AttributeError):
        return None


def native_available():
    return os.environ.get('PENPLOT_NATIVE_GEOMETRY', '1') != '0' and _load() is not None


def _buffers(paths):
    if not native_available():
        return None
    # A materialized PackedPaths may have externally edited Path objects;
    # fall back to those objects rather than mutating its stale packed copy.
    if getattr(paths, '_paths', None) is not None:
        return None
    coords, offsets = getattr(paths, 'xy', None), getattr(paths, 'offsets', None)
    if (isinstance(coords, array) and coords.typecode == 'd'
            and isinstance(offsets, array) and offsets.typecode == 'Q'):
        if (len(coords) % 2 or not offsets or offsets[0] != 0
                or offsets[-1] != len(coords) // 2
                or any(a > b for a, b in zip(offsets, offsets[1:]))):
            return None
        return coords, offsets, None
    # Never consume a generator before the fallback gets to see it.
    if not isinstance(paths, (list, tuple)):
        return None
    if sum(len(p.coords) for p in paths) < MIN_COORDS:
        return None
    seen = set()
    from .geometry import Path as GeometryPath
    for p in paths:
        if type(p) is not GeometryPath:
            return None
        c = p.coords
        if not (type(c) is array and c.typecode == 'd') or len(c) % 2:
            return None
        if id(c) in seen:
            return None
        seen.add(id(c))
    coords, offsets = array('d'), array('Q', [0])
    for p in paths:
        coords.extend(p.coords)
        offsets.append(len(coords) // 2)
    return coords, offsets, paths


def _transform(buffers, operations):
    coords, _, _ = buffers
    params = array('d', (v for op in operations for v in op))
    _load().penplot_geometry_transform(
        (ct.c_double * len(coords)).from_buffer(coords), len(coords) // 2,
        (ct.c_double * len(params)).from_buffer(params), len(operations))


def _commit(buffers):
    coords, offsets, paths = buffers
    if paths is not None:
        for p, start, end in zip(paths, offsets, offsets[1:]):
            values = coords[start * 2:end * 2]
            p.coords[:] = values if isinstance(p.coords, array) else values.tolist()


def try_transform(paths, operations):
    """Apply rows (opcode, six parameters); return False without mutation on fallback."""
    buffers = _buffers(paths)
    if buffers is None:
        return False
    _transform(buffers, operations)
    _commit(buffers)
    return True


def _bbox(buffers):
    coords, offsets, _ = buffers
    result = (ct.c_double * 4)()
    status = _load().penplot_geometry_bbox(
        (ct.c_double * len(coords)).from_buffer(coords), len(coords) // 2,
        (ct.c_uint64 * len(offsets)).from_buffer(offsets), len(offsets) - 1, result)
    return tuple(result) if status == 1 else None if status == 0 else UNSUPPORTED


def try_bbox(paths):
    buffers = _buffers(paths)
    return UNSUPPORTED if buffers is None else _bbox(buffers)


def try_export_mm(paths, width, height, origin, machine_type, anchor_bbox):
    """Export packed pages without materializing paths for content anchoring.

    Explicit anchor rectangles need only four Python probe points, allowing
    one fused transform. Automatic content bounds require a native bbox after
    rotation and before origin translation, so rotation is a separate batch.
    """
    buffers = _buffers(paths)
    if buffers is None:
        return False
    from .geometry import Affine2D, Path as GeometryPath, bbox_of
    o = origin
    anchor_bbox = getattr(o, 'anchor_bbox', None) or anchor_bbox
    probe = None
    if o.anchor == 'content' and anchor_bbox is not None:
        x0, y0, x1, y1 = anchor_bbox
        probe = GeometryPath()
        probe.move_to(x0, y0)
        for x, y in ((x1, y0), (x1, y1), (x0, y1)):
            probe.line_to(x, y)
    operations = []
    if o.rotation:
        aff = Affine2D().rotate_deg_around(o.rotation, width / 2.0, height / 2.0)
        operations.append((0, *aff.get_matrix()))
        if probe is not None:
            probe.transform(aff)
        if o.rotation % 180 != 0:
            delta = (height - width) / 2.0
            operations.append((1, delta, -delta, 0, 0, 0, 0))
            if probe is not None:
                for i in range(0, len(probe.coords), 2):
                    probe.coords[i] += delta
                    probe.coords[i + 1] += -delta
            width, height = height, width
    if o.anchor == 'content':
        if probe is not None:
            bb = bbox_of([probe])
        else:
            if operations:
                _transform(buffers, operations)
                operations = []
            bb = _bbox(buffers)
        if bb is None:
            cx = cy = 0.0
        else:
            x0, y0, x1, y1 = bb
            cx = x1 if o.corner in (1, 3) else x0
            cy = y1 if o.corner in (2, 3) else y0
    else:
        cx = width if o.corner in (1, 3) else 0.0
        cy = height if o.corner in (2, 3) else 0.0
    mx = cx - o.offset_x_mm if o.corner in (1, 3) else cx + o.offset_x_mm
    my = cy - o.offset_y_mm if o.corner in (2, 3) else cy + o.offset_y_mm
    if mx or my:
        operations.append((1, -mx, -my, 0, 0, 0, 0))
    operations.append((3, o.revxy, o.x_rev, o.y_rev, machine_type == 'Ebb', width, 0))
    _transform(buffers, operations)
    _commit(buffers)
    return True
