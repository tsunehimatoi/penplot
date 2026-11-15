"""Character-category and weighted-mix font resolution."""

from __future__ import annotations

import random
import unicodedata
from typing import TYPE_CHECKING, Literal, Optional, Sequence

if TYPE_CHECKING:
    from .fonts import GFont

CharCategory = Literal['en', 'zh', 'symbol', 'other']
FontRoleKey = Literal['en', 'zh', 'symbol', 'fallback']
FONT_ROLE_KEYS: tuple[FontRoleKey, ...] = ('en', 'zh', 'symbol', 'fallback')


def _is_cjk(code: int) -> bool:
    return (
        0x4E00 <= code <= 0x9FFF      # CJK Unified Ideographs
        or 0x3400 <= code <= 0x4DBF   # CJK Extension A
        or 0xF900 <= code <= 0xFAFF   # CJK Compatibility Ideographs
        or 0x2E80 <= code <= 0x2EFF   # CJK Radicals Supplement
        or 0x3100 <= code <= 0x312F   # Bopomofo
        or 0x31A0 <= code <= 0x31BF   # Bopomofo Extended
        or 0x20000 <= code <= 0x2EBEF # CJK Extensions B-F
        or 0x30000 <= code <= 0x323AF # CJK Extensions G-H
    )


def char_category(ch: str) -> CharCategory:
    """Classify a character into 'en', 'zh', 'symbol', or 'other'."""
    if not ch:
        return 'other'
    code = ord(ch)
    if (0x41 <= code <= 0x5A) or (0x61 <= code <= 0x7A) or (0x30 <= code <= 0x39):
        return 'en'
    if _is_cjk(code):
        return 'zh'
    if (
        0x3000 <= code <= 0x303F       # CJK Symbols and Punctuation
        or 0xFF00 <= code <= 0xFFEF    # Halfwidth and Fullwidth Forms
        or 0x2000 <= code <= 0x27BF    # General Punctuation, Arrows, Math, Dingbats
    ):
        return 'symbol'
    cat = unicodedata.category(ch)
    if cat and cat[0] in ('P', 'S'):
        return 'symbol'
    return 'other'


class FontResolver:
    """Resolves the font for each character using role overrides, weighted mix, and fallback."""

    def __init__(
        self,
        primary: GFont,
        font_mix: Optional[Sequence[tuple[GFont, float]]] = None,
        font_roles: Optional[dict[str, GFont]] = None,
    ) -> None:
        self.primary = primary
        self.font_mix: list[tuple[GFont, float]] = [
            (f, float(w)) for f, w in (font_mix or ()) if float(w) > 0
        ]
        self.font_roles: dict[str, GFont] = dict(font_roles or {})

    def pick(self, ch: str, rng: random.Random) -> GFont:
        cat = char_category(ch)
        if cat in ('en', 'zh', 'symbol'):
            role_font = self.font_roles.get(cat)
            if role_font is not None and role_font.has_glyph(ch):
                return role_font

        if self.font_mix:
            candidates = [(f, w) for f, w in self.font_mix if f.has_glyph(ch)]
            if candidates:
                if len(candidates) == 1:
                    return candidates[0][0]
                fonts, weights = zip(*candidates)
                return rng.choices(fonts, weights=weights, k=1)[0]

        if self.primary.has_glyph(ch):
            return self.primary

        fallback = self.font_roles.get('fallback')
        if fallback is not None and fallback.has_glyph(ch):
            return fallback

        return self.primary
