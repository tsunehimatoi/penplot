"""Tests for per-category font_roles, weighted font_mix, and fallback resolution."""

import random

from penplot.compose import flow_text_pages, text_box_paths
from penplot.font_resolver import FontResolver, char_category
from penplot.geometry import Path
from penplot.settings import Settings


class _MockGlyph:
    def __init__(self):
        p = Path()
        p.move_to(0, 0)
        p.line_to(10, 10)
        self.coords = p.coords
        self.ops = p.ops
        self.advance = 12.0


class _MockFont:
    def __init__(self, name: str, chars: str):
        self.name = name
        self.size = 100.0
        self._chars = set(chars)

    def has_glyph(self, ch: str) -> bool:
        return ch in self._chars

    def glyph(self, ch: str):
        if ch in self._chars:
            return _MockGlyph()
        return None


class _MockResources:
    def __init__(self, fonts: dict[str, _MockFont]):
        self._fonts = fonts

    def font(self, font_id: str | None):
        return self._fonts[font_id or 'primary']


def test_char_category_classification():
    assert char_category('A') == 'en'
    assert char_category('z') == 'en'
    assert char_category('5') == 'en'
    assert char_category('汉') == 'zh'
    assert char_category('字') == 'zh'
    assert char_category('，') == 'symbol'
    assert char_category('!') == 'symbol'
    assert char_category('+') == 'symbol'
    assert char_category(' ') == 'other'


def test_font_resolver_roles_and_fallback():
    primary = _MockFont('primary', 'A中')
    en = _MockFont('en', 'AB')
    zh = _MockFont('zh', '汉')
    symbol = _MockFont('sym', '，+')
    fallback = _MockFont('fb', 'αβ中')

    resolver = FontResolver(
        primary,
        font_roles={'en': en, 'zh': zh, 'symbol': symbol, 'fallback': fallback},
    )
    rng = random.Random(42)

    assert resolver.pick('A', rng) is en
    assert resolver.pick('B', rng) is en
    assert resolver.pick('汉', rng) is zh
    # '中' is not in zh role, falls back to primary
    assert resolver.pick('中', rng) is primary
    assert resolver.pick('，', rng) is symbol
    assert resolver.pick('+', rng) is symbol
    # 'α' is not in primary/other roles, uses fallback
    assert resolver.pick('α', rng) is fallback
    # completely missing char returns primary
    assert resolver.pick('?', rng) is primary


def test_font_resolver_weighted_mix():
    f1 = _MockFont('f1', 'ab')
    f2 = _MockFont('f2', 'ab')
    resolver = FontResolver(f1, font_mix=[(f1, 0.8), (f2, 0.2)])
    rng = random.Random(123)
    picks = [resolver.pick('a', rng).name for _ in range(200)]
    c1 = picks.count('f1')
    c2 = picks.count('f2')
    assert c1 > c2
    assert c2 > 10


def test_compose_text_and_flow_text_with_font_roles():
    res = _MockResources({
        'primary': _MockFont('primary', ' '),
        'en': _MockFont('en', 'Hello'),
        'zh': _MockFont('zh', '你好'),
        'sym': _MockFont('sym', '！'),
        'fb': _MockFont('fb', '★'),
    })
    settings = Settings()
    warn = {'missing': set(), 'overflow': False}
    props = {
        'text': 'Hello你好！★',
        'font_id': 'primary',
        'font_roles': {'en': 'en', 'zh': 'zh', 'symbol': 'sym', 'fallback': 'fb'},
        'size_mm': 8.0,
        'line_height': 1.3,
    }
    paths = text_box_paths({'id': 't1', 'props': props}, res, {}, settings, warn)
    assert len(paths) == 9
    assert not warn['missing']

    warn2 = {'missing': set(), 'overflow': False}
    paper = {'width_mm': 210, 'height_mm': 297, 'margins': {'left': 20, 'right': 20, 'top': 20, 'bottom': 20}, 'ruling': {'lines': 20}}
    pages = flow_text_pages({'id': 'f1', 'props': {**props, 'format': 'markdown'}}, paper, res, {}, settings, warn2)
    assert len(pages) == 1
    assert len(pages[0]) == 9
    assert not warn2['missing']


def test_post_builtin_glyphs_batch(app):
    from fastapi.testclient import TestClient

    with TestClient(app, base_url='http://testserver') as c:
        r = c.post(
            '/api/v1/fonts/builtin/glyphs',
            json={'text': 'AB中A文B'},
            headers={'X-Penplot': '1'},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data['font_id'] == 'builtin'
        assert isinstance(data['ref_size'], (int, float)) and data['ref_size'] > 0
        assert data['total'] == 4
        chars = [g['char'] for g in data['glyphs']]
        assert chars == ['A', 'B']
        for g in data['glyphs']:
            assert 'cp' in g
            assert isinstance(g['x0'], (int, float))
            assert isinstance(g['w'], (int, float)) and g['w'] > 0
            assert isinstance(g['path_d'], str) and len(g['path_d']) > 0
