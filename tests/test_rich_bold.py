"""Rich-text emphasis must never add an offset copy to plotter strokes."""
import pytest

from penplot.compose import render_document
from penplot.gcode import parse_gcode
from penplot.gfont import GFont, Glyph
from penplot.geometry import LINE, MOVE
from penplot.settings import MachineConfig


class _Fonts:
    def __init__(self):
        self.value = GFont()
        self.value.size = 100.0
        # Two disconnected strokes per glyph: preserve both, without retracing either.
        for ch in 'AB':
            self.value.inline[ord(ch)] = Glyph(ch, [0, 0, 30, -70, 40, -20, 60, 0], [MOVE, LINE, MOVE, LINE])

    def font(self, _fid):
        return self.value


def _render(content, fmt='markdown', jitter=None, rich_style=None):
    paper = {'width_mm': 50, 'height_mm': 60, 'margins': {'l': 5, 'r': 5, 't': 5, 'b': 5},
             'ruling': {'line_num': 5}}
    el = {'id': 'bold-test', 'type': 'flow_text', 'props': {
        'text': content, 'format': fmt, 'seed': 7, 'jitter': jitter or {}, 'rich_style': rich_style or {},
    }}
    mc = MachineConfig(machine_type='Grbl')
    pages = render_document({'pages': [{'elements': [el]}]}, [paper], _Fonts(), mc,
                            opts={'optimize': False})
    return pages, mc


@pytest.mark.parametrize('fmt,plain,bold', [
    ('markdown', 'A B', '**A** B'),
    ('markdown', 'A B', '__A__ B'),
    ('html', '<p>A B</p>', '<p><strong>A</strong> B</p>'),
    ('html', '<p>A B</p>', '<p><b>A</b> B</p>'),
    ('html', '<p><i><u>A</u></i> B</p>', '<p><b><i><u>A</u></i></b> B</p>'),
    ('markdown', ('A B ' * 50).strip(), ('**A** B ' * 50).strip()),
])
@pytest.mark.parametrize('jitter', [None, {'randomFontSize': [0.9, 1.1], 'randomRotate': [-5, 5],
                                        'randomY': 0.1, 'randomSpace': [0.8, 1.2]}])
def test_bold_preserves_layout_and_export(fmt, plain, bold, jitter):
    normal, mc = _render(plain, fmt, jitter)
    emphasized, _ = _render(bold, fmt, jitter)
    assert len(normal) == len(emphasized)
    if len(plain) > 100:
        assert len(normal) > 1
    for expected, actual in zip(normal, emphasized):
        assert actual.page_paths
        assert actual.gcode == expected.gcode
        assert actual.bbox == expected.bbox
        assert [(p.ops, p.coords) for p in actual.page_paths] == [(p.ops, p.coords) for p in expected.page_paths]
        assert len(parse_gcode(actual.gcode, mc)) == len(actual.machine_paths)


@pytest.mark.parametrize('fmt,content,stroke_count', [
    ('markdown', '**AB**', 4),
    ('html', '<p><strong>AB</strong></p>', 4),
    ('markdown', '# AB', 4),
    ('html', '<h1>AB</h1>', 4),
    # Table header + body: four glyph strokes, plus two vertical borders per row.
    ('markdown', '| A |\n| --- |\n| B |', 8),
    ('html', '<table><tr><th>A</th></tr><tr><td>B</td></tr></table>', 8),
])
def test_emphasis_headings_and_headers_write_each_stroke_once(fmt, content, stroke_count):
    pages, mc = _render(content, fmt)
    assert len(pages) == 1
    assert len(pages[0].page_paths) == stroke_count
    assert len(parse_gcode(pages[0].gcode, mc)) == stroke_count


def test_heading_keeps_larger_glyphs():
    normal, _ = _render('AB')
    heading, _ = _render('# AB')
    def width(page):
        xs = page.page_paths[0].coords[::2]
        return max(xs) - min(xs)
    assert width(heading[0]) == pytest.approx(width(normal[0]) * 1.35)
