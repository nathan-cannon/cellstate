"""
Unicode display width: how many terminal columns a character occupies (0, 1, or 2).
Width tables derived from Unicode 17.0 data.
"""

from __future__ import annotations
import bisect
from .emoji_data import EMOJI_PRESENTATION_RANGES, TEXT_PRESENTATION_EMOJI_RANGES

# Pre-compute sorted start/end lists for fast bisect lookups.
_EP_STARTS = [r[0] for r in EMOJI_PRESENTATION_RANGES]
_EP_ENDS   = [r[1] for r in EMOJI_PRESENTATION_RANGES]
_TP_STARTS = [r[0] for r in TEXT_PRESENTATION_EMOJI_RANGES]
_TP_ENDS   = [r[1] for r in TEXT_PRESENTATION_EMOJI_RANGES]


def _in_ranges(cp: int, starts: list[int], ends: list[int]) -> bool:
    """Binary search through sorted [start, end] inclusive ranges."""
    idx = bisect.bisect_right(starts, cp) - 1
    if idx < 0:
        return False
    return cp <= ends[idx]


def char_display_width(code_point: int) -> int:
    """
    Return the display width of a single Unicode code point.
    Returns 2 for fullwidth/wide characters (CJK, emoji, etc).
    Returns 0 for zero-width characters (combining marks, ZWJ, etc).
    Returns 1 for everything else.
    """
    if _is_zero_width(code_point):
        return 0
    # Terminal-specific overrides: 🈂 (U+1F202) and 🈷 (U+1F237) render as
    # width 2 in most terminals despite Emoji_Presentation=No.
    if code_point == 0x1F202 or code_point == 0x1F237:
        return 2
    if _is_wide(code_point):
        return 2
    return 1


def is_text_presentation_emoji(code_point: int) -> bool:
    """
    Returns True if the code point is a text-presentation emoji
    (Emoji=Yes but Emoji_Presentation=No). These are width 1 by default
    but become width 2 when followed by U+FE0F (VS16).
    """
    return _in_ranges(code_point, _TP_STARTS, _TP_ENDS)


def _is_zero_width(cp: int) -> bool:
    if 0x0300 <= cp <= 0x036F: return True   # Combining Diacritical Marks
    if 0x0483 <= cp <= 0x0489: return True   # Combining Cyrillic
    if 0x0591 <= cp <= 0x05BD: return True   # Hebrew combining
    if 0x0610 <= cp <= 0x061A: return True   # Arabic combining
    if 0x064B <= cp <= 0x065F: return True
    if cp == 0x0670: return True
    if 0x06D6 <= cp <= 0x06DC: return True
    if 0x06DF <= cp <= 0x06E4: return True
    if 0x06E7 <= cp <= 0x06E8: return True
    if 0x06EA <= cp <= 0x06ED: return True
    if cp == 0x0711: return True             # Syriac combining
    if 0x0730 <= cp <= 0x074A: return True
    if 0x200B <= cp <= 0x200F: return True   # Zero-width space, ZWNJ, ZWJ, direction marks
    if 0x2028 <= cp <= 0x202E: return True   # Line/paragraph separators, direction overrides
    if 0x2060 <= cp <= 0x2064: return True   # Word joiner, invisible operators
    if 0x20D0 <= cp <= 0x20FF: return True   # Combining Marks for Symbols
    if 0xFE00 <= cp <= 0xFE0F: return True   # Variation Selectors
    if 0xFE20 <= cp <= 0xFE2F: return True   # Combining Half Marks
    if cp == 0xFEFF: return True             # BOM / zero-width no-break space
    if 0xE0100 <= cp <= 0xE01EF: return True # Variation Selectors Supplement
    if 0xE0020 <= cp <= 0xE007F: return True # Tag characters
    return False


def _is_wide(cp: int) -> bool:
    if 0x1100 <= cp <= 0x115F: return True   # Hangul Jamo
    if 0x2E80 <= cp <= 0x303E: return True   # CJK Radicals, Kangxi, CJK Symbols
    if 0x3040 <= cp <= 0x33BF: return True   # Hiragana, Katakana, Bopomofo, etc.
    if 0x3400 <= cp <= 0x4DBF: return True   # CJK Extension A
    if 0x4E00 <= cp <= 0x9FFF: return True   # CJK Unified Ideographs
    if 0xA000 <= cp <= 0xA4CF: return True   # Yi
    if 0xAC00 <= cp <= 0xD7AF: return True   # Hangul Syllables
    if 0xF900 <= cp <= 0xFAFF: return True   # CJK Compat Ideographs
    if 0xFE10 <= cp <= 0xFE6F: return True   # CJK Compat Forms, Small Forms
    if 0xFF01 <= cp <= 0xFF60: return True   # Fullwidth Forms
    if 0xFFE0 <= cp <= 0xFFE6: return True   # Fullwidth Signs
    if _in_ranges(cp, _EP_STARTS, _EP_ENDS): return True  # Emoji with default emoji presentation
    if 0x20000 <= cp <= 0x2FFFF: return True # CJK Extension B and beyond
    if 0x30000 <= cp <= 0x3FFFF: return True # CJK Extension G+
    return False


def is_skin_tone_modifier(cp: int) -> bool:
    """Returns True if a codepoint is a skin tone modifier (Fitzpatrick scale, U+1F3FB-U+1F3FF)."""
    return 0x1F3FB <= cp <= 0x1F3FF


def is_regional_indicator(cp: int) -> bool:
    """Returns True if a codepoint is a Regional Indicator Symbol (U+1F1E6-U+1F1FF)."""
    return 0x1F1E6 <= cp <= 0x1F1FF


def string_display_width(s: str) -> int:
    """
    Return the total display width of a string in terminal columns.
    Iterates by code point; accounts for VS16, skin tone modifiers,
    ZWJ sequences, and regional indicator pairs.
    """
    width = 0
    prev_cp = -1
    prev_was_zwj = False
    prev_was_ri = False
    for ch in s:
        cp = ord(ch)
        if (cp == 0xFE0F and prev_cp >= 0
                and is_text_presentation_emoji(prev_cp)
                and char_display_width(prev_cp) == 1):
            # VS16 after a text-presentation emoji: upgrade to width 2
            width += 1
            prev_cp = cp
            prev_was_zwj = False
            prev_was_ri = False
            continue
        w = char_display_width(cp)
        if is_skin_tone_modifier(cp) and prev_cp >= 0 and char_display_width(prev_cp) == 2:
            prev_cp = cp
            prev_was_zwj = False
            prev_was_ri = False
            continue
        if is_regional_indicator(cp) and prev_was_ri:
            prev_cp = cp
            prev_was_zwj = False
            prev_was_ri = False
            continue
        if prev_was_zwj and w == 2:
            prev_cp = cp
            prev_was_zwj = False
            prev_was_ri = False
            continue
        width += w
        prev_was_zwj = (cp == 0x200D)
        prev_was_ri = is_regional_indicator(cp)
        prev_cp = cp
    return width


def slice_to_width(text: str, max_cols: int) -> str:
    """
    Slice text from the start to fit within max_cols display columns.
    Never splits a surrogate pair, a wide character, or a grapheme cluster.
    """
    cols = 0
    str_idx = 0
    prev_cp = -1
    prev_was_zwj = False
    prev_was_ri = False
    cluster_start_idx = 0

    for ch in text:
        cp = ord(ch)
        part_of_cluster = False
        w: int

        if (cp == 0xFE0F and prev_cp >= 0
                and is_text_presentation_emoji(prev_cp)
                and char_display_width(prev_cp) == 1):
            w = 1
            part_of_cluster = True
        elif is_skin_tone_modifier(cp) and prev_cp >= 0 and char_display_width(prev_cp) == 2:
            w = 0
            part_of_cluster = True
        elif is_regional_indicator(cp) and prev_was_ri:
            w = 0
            part_of_cluster = True
        elif prev_was_zwj and char_display_width(cp) == 2:
            w = 0
            part_of_cluster = True
        else:
            w = char_display_width(cp)

        if cols + w > max_cols:
            if part_of_cluster:
                str_idx = cluster_start_idx
            break

        if not part_of_cluster:
            cluster_start_idx = str_idx

        cols += w
        str_idx += len(ch)
        prev_was_zwj = (cp == 0x200D)
        prev_was_ri = is_regional_indicator(cp) and not part_of_cluster
        prev_cp = cp

    return text[:str_idx]


def slice_from_end_to_width(text: str, max_cols: int) -> str:
    """
    Slice text from the end to fit within max_cols display columns.
    Never splits a surrogate pair, a wide character, or a grapheme cluster.
    """
    # Segment into grapheme clusters by forward-iterating
    clusters: list[str] = []
    current = ""
    prev_cp = -1
    prev_was_zwj = False
    prev_was_ri = False

    for ch in text:
        cp = ord(ch)
        part_of_cluster = False

        if (cp == 0xFE0F and prev_cp >= 0
                and is_text_presentation_emoji(prev_cp)
                and char_display_width(prev_cp) == 1):
            part_of_cluster = True
        elif is_skin_tone_modifier(cp) and prev_cp >= 0 and char_display_width(prev_cp) == 2:
            part_of_cluster = True
        elif is_regional_indicator(cp) and prev_was_ri:
            part_of_cluster = True
        elif prev_was_zwj and char_display_width(cp) == 2:
            part_of_cluster = True
        elif _is_zero_width(cp):
            part_of_cluster = True

        if part_of_cluster:
            current += ch
        else:
            if current:
                clusters.append(current)
            current = ch

        prev_was_zwj = (cp == 0x200D)
        prev_was_ri = is_regional_indicator(cp) and not part_of_cluster
        prev_cp = cp

    if current:
        clusters.append(current)

    # Iterate clusters from end
    cols = 0
    count = 0
    for cluster in reversed(clusters):
        w = string_display_width(cluster)
        if cols + w > max_cols:
            break
        cols += w
        count += 1

    return "".join(clusters[len(clusters) - count:])
