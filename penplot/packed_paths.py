"""Double-precision path storage for page postprocessing.

Offsets count points, not coordinate scalars or bytes. Legacy Path consumers
materialize a list only on access; buffers are refreshed after such access so
mutations to those Paths remain visible. Internal consumers use buffers().
"""
from array import array
from collections.abc import Sequence

from .geometry import Path, bbox_of


class PackedPaths(Sequence):
    def __init__(self, xy=None, ops=None, offsets=None):
        self.xy = xy if xy is not None else array('d')
        self.ops = ops if ops is not None else array('B')
        self.offsets = offsets if offsets is not None else array('Q', [0])
        self._paths = None

    @classmethod
    def from_paths(cls, paths, split=False):
        """Pack paths; split=True exactly follows Path.subpaths semantics."""
        if isinstance(paths, cls) and not split:
            return paths
        result = cls()
        xy, ops, offsets = result.xy, result.ops, result.offsets
        for path in paths:
            c, o = path.coords, path.ops
            if len(c) != 2 * len(o):
                raise ValueError('path coordinate/operation length mismatch')
            if not split:
                xy.extend(c)
                ops.extend(o)
                offsets.append(len(ops))
                continue
            starts = [i for i, op in enumerate(o) if op == 0]
            if not starts:
                continue
            base = len(ops)
            first = starts[0]
            xy.extend(c[2 * first:] if first else c)
            # Path.subpaths treats every non-MOVE operation as LINE.
            ops.extend(array('B', [1]) * (len(o) - first))
            for start in starts:
                point = base + start - first
                ops[point] = 0
                if start != first:
                    offsets.append(point)
            offsets.append(len(ops))
        return result

    def buffers(self):
        if self._paths is not None:
            packed = type(self).from_paths(self._paths)
            self.xy, self.ops, self.offsets = packed.xy, packed.ops, packed.offsets
        return self.xy, self.ops, self.offsets

    def _materialize(self):
        if self._paths is None:
            self._paths = [Path(self.xy[2 * a:2 * b], self.ops[a:b])
                           for a, b in zip(self.offsets, self.offsets[1:])]
        return self._paths

    def __len__(self):
        return len(self._paths) if self._paths is not None else len(self.offsets) - 1

    def __getitem__(self, index):
        return self._materialize()[index]

    def __iter__(self):
        return iter(self._materialize())

    def clone(self):
        xy, ops, offsets = self.buffers()
        return type(self)(array('d', xy), array('B', ops), array('Q', offsets))

    def bbox(self):
        # Keep per-path NaN/min/max behavior identical to bbox_of(list).
        xy, ops, offsets = self.buffers()
        from .native_geometry import try_bbox, UNSUPPORTED
        native = try_bbox(self)
        if native is not UNSUPPORTED:
            return native
        def views():
            coords = memoryview(xy)
            for a, b in zip(offsets, offsets[1:]):
                path = Path()
                path.coords = coords[2 * a:2 * b]
                yield path
        return bbox_of(views())
