"""Bounded, lossless paper-space cache shared by preview/print worker processes.

Only composition is cached. Placement, ordering, machine origins and G-code
must run after loading; no mutable Path is retained between calls.
"""
from array import array
from collections import OrderedDict
import hashlib
import io
import json
import os
import struct
import sys
import tempfile

from .geometry import Path

VERSION = 2
MAX_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 16
_MAGIC = b'PPLC\x01'


class GlyphPathCache:
    """Small document-local cache of immutable glyph snapshots, never RNG state."""

    def __init__(self, max_entries=512, max_bytes=2 * 1024 * 1024):
        self.entries = OrderedDict()
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.size = 0

    def get(self, key):
        value = self.entries.get(key)
        if value is None:
            return None
        self.entries.move_to_end(key)
        coords, ops, advance = value
        values = array('d')
        values.frombytes(coords)
        return Path(values, ops), advance

    def put(self, key, path, advance):
        coords, ops = array('d', path.coords).tobytes(), bytes(path.ops)
        size = len(coords) + len(ops)
        if size > self.max_bytes or self.max_entries <= 0:
            return
        old = self.entries.pop(key, None)
        if old:
            self.size -= len(old[0]) + len(old[1])
        self.entries[key] = (coords, ops, advance)
        self.size += size
        while len(self.entries) > self.max_entries or self.size > self.max_bytes:
            _, old = self.entries.popitem(last=False)
            self.size -= len(old[0]) + len(old[1])


def _json_default(value):
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    return vars(value)


def _ident(path):
    path = os.path.realpath(path)
    st = os.stat(path)
    return [path, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def composition_key(doc, papers, res, mc, variables=None, page_filter=None):
    """Conservative key: includes all resolver assets (including role fonts).

    The machine configuration is included because imported G-code depends on
    it. External origin/placement arguments are deliberately not inputs here.
    """
    from . import builtin_font
    data = {'version': VERSION, 'doc': doc, 'papers': papers, 'mc': mc,
            'variables': variables or {}, 'filter': sorted(page_filter) if page_filter is not None else None,
            'default_font': res.default_font,
            'fonts': {k: _ident(v) for k, v in res.fonts.items()},
            'files': {k: _ident(v) for k, v in res.files.items()},
            'builtin': _ident(builtin_font.__file__)}
    raw = json.dumps(data, sort_keys=True, default=_json_default, allow_nan=False).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def encode_composition(pages):
    """Keep path boundaries, ops and IEEE float64 values exactly as composed."""
    meta = [[src, paper, warn, len(paths)] for src, paper, paths, warn in pages]
    raw = json.dumps(meta, default=_json_default).encode('utf-8')
    out = io.BytesIO()
    out.write(_MAGIC + struct.pack('<I', len(raw)) + raw)
    for _src, _paper, paths, _warn in pages:
        for path in paths:
            if len(path.coords) != 2 * len(path.ops) or any(op not in (0, 1) for op in path.ops):
                raise ValueError('unsupported layout path')
            coords = array('d', path.coords)
            if sys.byteorder != 'little':
                coords.byteswap()
            out.write(struct.pack('<I', len(path.ops)))
            out.write(bytes(path.ops))
            out.write(coords.tobytes())
    return out.getvalue()


def decode_composition(data):
    if not data.startswith(_MAGIC):
        raise ValueError('invalid layout cache')
    size, = struct.unpack_from('<I', data, len(_MAGIC))
    offset = len(_MAGIC) + 4
    meta = json.loads(data[offset:offset + size])
    offset += size
    out = []
    for src, paper, warn, count in meta:
        paths = []
        for _ in range(count):
            n, = struct.unpack_from('<I', data, offset)
            offset += 4
            end = offset + n * 17
            if end > len(data):
                raise ValueError('truncated layout cache')
            ops = data[offset:offset + n]
            coords = array('d')
            coords.frombytes(data[offset + n:end])
            if sys.byteorder != 'little':
                coords.byteswap()
            paths.append(Path(coords, ops))
            offset = end
        warn['missing'] = set(warn['missing'])
        out.append((src, paper, paths, warn))
    if offset != len(data):
        raise ValueError('trailing layout cache data')
    return out


def _prune(directory):
    entries = []
    for entry in os.scandir(directory):
        if entry.name.endswith('.layout'):
            try:
                st = entry.stat()
                entries.append((st.st_mtime_ns, st.st_size, entry.path))
            except OSError:
                pass
    total = sum(size for _, size, _ in entries)
    remaining = len(entries)
    for _, size, path in sorted(entries):
        if total <= MAX_BYTES and remaining <= MAX_ENTRIES:
            break
        try:
            os.unlink(path)
            total -= size
            remaining -= 1
        except OSError:
            pass


def cached_compose(build, doc, papers, res, mc, variables=None, page_filter=None, progress=None):
    """Drop-in compose wrapper; build has compose_pages' unchanged signature.

    Integrate by wrapping compose_pages' uncached implementation. Resolver's
    existing cache_dir is shared by all task workers; None disables reuse.
    """
    args = (doc, papers, res, mc, variables, page_filter, progress)
    directory = getattr(res, 'cache_dir', None)
    if not directory:
        return build(*args)
    # Pure letters already persist their expensive local layout. Writing the
    # same large arrays again at document level doubles cold-preview IO and
    # provides no reuse across the canvas scratch and real print documents.
    visible = (el for page in doc.get('pages') or [] for el in page.get('elements') or []
               if not el.get('hidden'))
    if all(el.get('type') == 'flow_text' for el in visible):
        return build(*args)
    try:
        key = composition_key(doc, papers, res, mc, variables, page_filter)
    except (OSError, TypeError, ValueError, AttributeError):
        return build(*args)
    return _cached_pages(directory, key, lambda: build(*args), progress)


def flow_key(el, paper, res, variables, settings):
    """Element-local layout identity, independent of scratch document framing."""
    from . import builtin_font
    props = el.get('props') or {}
    ids = [props.get('font_id')] + [m.get('font_id') for m in props.get('font_mix') or []]
    ids += list((props.get('font_roles') or {}).values())
    fonts = {}
    for fid in ids:
        fid = fid or res.default_font
        path = res.fonts.get(fid) if fid else None
        fonts[str(fid)] = _ident(path) if path else ['builtin', _ident(builtin_font.__file__)]
    data = {'version': VERSION, 'id': el.get('id'), 'props': props, 'paper': paper,
            'variables': variables or {}, 'settings': settings, 'fonts': fonts,
            'default_font': res.default_font}
    raw = json.dumps(data, sort_keys=True, default=_json_default, allow_nan=False).encode('utf-8')
    return 'flow-' + hashlib.sha256(raw).hexdigest()


def cached_flow(build, el, paper, res, variables, settings, warn):
    """Reuse flow_text_pages before element transform, across scratch/real docs.

    Warnings are recorded independently of the caller's accumulated warnings,
    then merged on both miss and hit. Each load owns its paths and metadata.
    """
    directory = getattr(res, 'cache_dir', None)
    if not directory:
        return build(el, paper, res, variables, settings, warn)
    try:
        key = flow_key(el, paper, res, variables, settings)
    except (OSError, TypeError, ValueError, AttributeError):
        return build(el, paper, res, variables, settings, warn)

    def build_pages():
        local = {'missing': set(), 'overflow': False, 'messages': []}
        pages = build(el, paper, res, variables, settings, local)
        # A metadata record also preserves warnings for an empty page list.
        return [(0, {}, [], local)] + [(i, {}, paths, {'missing': set()})
                                       for i, paths in enumerate(pages)]

    records = _cached_pages(directory, key, build_pages,
                            validate=lambda rows: bool(rows) and not rows[0][2])
    local = records[0][3]
    warn['missing'] |= local['missing']
    if local.get('overflow'):
        warn['overflow'] = True
    for message in local.get('messages') or []:
        if message not in warn.setdefault('messages', []):
            warn['messages'].append(message)
    return [paths for _, _, paths, _ in records[1:]]


def _cached_pages(directory, key, build, progress=None, validate=None):
    """Shared bounded disk store for composition and element-local flow records."""
    directory = os.path.join(directory, 'layout-v%d' % VERSION)
    filename = os.path.join(directory, key + '.layout')
    try:
        with open(filename, 'rb') as f:
            if os.fstat(f.fileno()).st_size > MAX_BYTES:
                raise ValueError('oversized layout cache')
            pages = decode_composition(f.read())
            if validate is not None and not validate(pages):
                raise ValueError('invalid layout cache records')
        os.utime(filename, None)
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, struct.error):
        pages = None
    if pages is not None:
        if progress:
            progress(0.6, '已复用排版路径')
        return pages
    pages = build()
    try:
        if sum(len(path.ops) * 17 + 4 for _, _, paths, _ in pages for path in paths) > MAX_BYTES:
            return pages
        data = encode_composition(pages)
    except (TypeError, ValueError, OverflowError, AttributeError, struct.error):
        return pages
    if len(data) > MAX_BYTES:
        return pages
    tmp = None
    try:
        os.makedirs(directory, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory, prefix='.', suffix='.tmp', delete=False) as f:
            tmp = f.name
            f.write(data)
        os.replace(tmp, filename)
        _prune(directory)
    except OSError:
        pass
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return pages
