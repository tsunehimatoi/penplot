"""Exact greedy path ordering with a removable endpoint spatial index.

The input list is retained; Path objects are reversed/merged in place, exactly
like the legacy optimizer. No NumPy or SciPy dependency is required.
"""
import math


def _dist2(x, y, xx, yy):
    dx, dy = x - xx, y - yy
    return dx * dx + dy * dy


def _optimize_paths_py(paths, near_dst: float):
    """Stage 2 (c.c): greedy nearest-neighbour ordering with merge/reverse.

    The current working polyline keeps absorbing the nearest remaining
    polyline while the gap <= near_dst; otherwise it is closed into the
    output and the nearest becomes the new working polyline.
    """
    remaining = list(paths)
    if not remaining:
        return []
    out = []
    cur = remaining.pop(0)
    while cur is not None:
        if out:
            prev = out[-1]
            ex, ey = prev.coords[-2], prev.coords[-1]
            sx, sy = cur.coords[0], cur.coords[1]
            if math.hypot(ex - sx, ey - sy) <= near_dst:
                prev.append(cur)
                cur = prev          # keep extending the merged polyline
            else:
                out.append(cur)
        else:
            out.append(cur)
        if not cur.coords:
            break
        ex, ey = cur.coords[-2], cur.coords[-1]
        best_i = None
        best_d = float('inf')
        best_tail = False
        for i, p in enumerate(remaining):
            d_head = _dist2(ex, ey, p.coords[0], p.coords[1])
            d_tail = _dist2(ex, ey, p.coords[-2], p.coords[-1])
            d = d_head if d_head < d_tail else d_tail
            if d < best_d:
                best_d = d
                best_i = i
                best_tail = d_tail < d_head
        if best_i is None:
            cur = None
        else:
            nxt = remaining.pop(best_i)
            if best_tail:
                nxt.reverse()
            cur = nxt
    return out


_NUMPY_MIN = 64


def _optimize_paths_scan(paths, near_dst: float):
    """Legacy NumPy scan, retained for small inputs and compatibility fallback.

    Keep its endpoint snapshot and float64 conversion behavior for aliased
    paths and non-float coordinates as well as its non-finite fallback.
    """
    if len(paths) < _NUMPY_MIN:
        return _optimize_paths_py(paths, near_dst)
    try:
        import numpy as np
    except ImportError:          # numpy is optional for the core
        return _optimize_paths_py(paths, near_dst)
    if any(not p.coords for p in paths):
        return _optimize_paths_py(paths, near_dst)
    if not all(math.isfinite(v) for p in paths for v in (p.coords[0], p.coords[1], p.coords[-2], p.coords[-1])):
        return _optimize_paths_py(paths, near_dst)
    remaining = list(paths)
    out = []
    cur = remaining[0]
    rest = remaining[1:]
    # endpoints of the not-yet-used polylines, in their original order
    idx = np.arange(len(rest))
    hx = np.array([p.coords[0] for p in rest], dtype=np.float64)
    hy = np.array([p.coords[1] for p in rest], dtype=np.float64)
    tx = np.array([p.coords[-2] for p in rest], dtype=np.float64)
    ty = np.array([p.coords[-1] for p in rest], dtype=np.float64)
    alive = np.ones(len(rest), dtype=bool)
    n_alive = len(rest)
    inf = float('inf')
    while cur is not None:
        if out:
            prev = out[-1]
            ex, ey = prev.coords[-2], prev.coords[-1]
            sx, sy = cur.coords[0], cur.coords[1]
            if math.hypot(ex - sx, ey - sy) <= near_dst:
                prev.append(cur)
                cur = prev
            else:
                out.append(cur)
        else:
            out.append(cur)
        if not cur.coords or n_alive == 0:
            break
        ex, ey = cur.coords[-2], cur.coords[-1]
        dx = ex - hx
        dy = ey - hy
        d_head = dx * dx + dy * dy
        dx = ex - tx
        dy = ey - ty
        d_tail = dx * dx + dy * dy
        tail = d_tail < d_head
        d = np.where(tail, d_tail, d_head)
        d[~alive] = inf
        k = int(np.argmin(d))            # first minimum = first in remaining order
        if not alive[k] or not d[k] < inf:
            break                        # reference: best_i stays None -> stop
        nxt = rest[int(idx[k])]
        if tail[k]:
            nxt.reverse()
        alive[k] = False
        n_alive -= 1
        cur = nxt
        if n_alive and n_alive * 2 < len(alive) and len(alive) > 256:
            keep = alive
            idx, hx, hy, tx, ty = idx[keep], hx[keep], hy[keep], tx[keep], ty[keep]
            alive = np.ones(len(idx), dtype=bool)
    return out


class _Node:
    __slots__ = ('bounds', 'left', 'right', 'points', 'parent', 'first')

    def __init__(self, points, leaves, parent=None):
        self.parent = parent
        self.first = min(p[2] for p in points)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        self.bounds = min(xs), min(ys), max(xs), max(ys)
        self.left = self.right = None
        if len(points) <= 16:
            self.points = sorted(points, key=lambda p: p[2])
            for x, y, i in points:
                leaves[i].append(self)
        else:
            axis = 0 if max(xs) - min(xs) >= max(ys) - min(ys) else 1
            points.sort(key=lambda p: p[axis])
            mid = len(points) // 2
            self.points = None
            self.left = _Node(points[:mid], leaves, self)
            self.right = _Node(points[mid:], leaves, self)

    def lower_bound(self, x, y):
        x0, y0, x1, y1 = self.bounds
        dx = x0 - x if x < x0 else x - x1 if x > x1 else 0.0
        dy = y0 - y if y < y0 else y - y1 if y > y1 else 0.0
        return dx * dx + dy * dy


class _EndpointIndex:
    def __init__(self, paths):
        self.alive = [True] * len(paths)
        self.leaves = [[] for _ in paths]
        points = []
        for i, p in enumerate(paths):
            points.append((p.coords[0], p.coords[1], i))
            points.append((p.coords[-2], p.coords[-1], i))
        self.root = _Node(points, self.leaves)

    def remove(self, i):
        self.alive[i] = False
        for leaf in self.leaves[i]:
            leaf.first = next((p[2] for p in leaf.points if self.alive[p[2]]), math.inf)
            node = leaf.parent
            while node is not None:
                first = min(node.left.first, node.right.first)
                if first == node.first:
                    break
                node.first = first
                node = node.parent

    def nearest(self, x, y):
        best_d, best_i = math.inf, math.inf
        stack = [(self.root, 0.0)]
        alive = self.alive
        while stack:
            node, lower = stack.pop()
            if node.first == math.inf or lower > best_d or (lower == best_d and node.first >= best_i):
                continue
            if node.points is not None:
                for px, py, i in node.points:
                    if not alive[i]:
                        continue
                    dx, dy = x - px, y - py
                    d = dx * dx + dy * dy
                    if d < best_d or (d == best_d and d < math.inf and i < best_i):
                        best_d, best_i = d, i
            else:
                left, right = node.left, node.right
                dl, dr = left.lower_bound(x, y), right.lower_bound(x, y)
                if (dl, left.first) < (dr, right.first):
                    stack.append((right, dr))
                    stack.append((left, dl))
                else:
                    stack.append((left, dl))
                    stack.append((right, dr))
        return None if best_i == math.inf else best_i


def optimize_paths(paths, near_dst: float):
    """Preserve legacy order, first-path ties, head ties and mutation semantics.

    Large finite inputs use a balanced endpoint tree. Bounding boxes only
    prune strictly farther distances (or ties with later original indices).
    Small, aliased, non-float, empty or non-finite inputs retain the legacy
    scan behavior. The 2048-path threshold avoids tree overhead on small jobs.
    """
    if len(paths) < 2048:
        return _optimize_paths_scan(paths, near_dst)
    if (len({id(p) for p in paths}) != len(paths)
            or len({id(p.coords) for p in paths}) != len(paths)
            or any(not p.coords for p in paths)
            or not all(type(v) is float and math.isfinite(v) for p in paths
                       for v in (p.coords[0], p.coords[1], p.coords[-2], p.coords[-1]))):
        return _optimize_paths_scan(paths, near_dst)
    rest = list(paths)
    index = _EndpointIndex(rest)
    index.remove(0)
    cur = rest[0]
    out = [cur]
    while True:
        ex, ey = cur.coords[-2:]
        i = index.nearest(ex, ey)
        if i is None:
            break
        nxt = rest[i]
        index.remove(i)
        hx, hy, tx, ty = nxt.coords[0], nxt.coords[1], nxt.coords[-2], nxt.coords[-1]
        if _dist2(ex, ey, tx, ty) < _dist2(ex, ey, hx, hy):
            nxt.reverse()
        if math.hypot(ex - nxt.coords[0], ey - nxt.coords[1]) <= near_dst:
            cur.append(nxt)
        else:
            out.append(nxt)
            cur = nxt
    return out
