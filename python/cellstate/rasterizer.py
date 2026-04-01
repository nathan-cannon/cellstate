"""Paints the laid-out TNode tree into a CellGrid."""

from __future__ import annotations
from typing import Any, Optional

from .cell import (
    Cell, CellGrid, Color, ColorMode,
    Attr, create_grid,
)
from .nodes import TNode, SegmentStyle
from .width import (
    char_display_width, string_display_width,
    is_text_presentation_emoji, is_skin_tone_modifier, is_regional_indicator,
)


class _BorderChars:
    __slots__ = ("tl", "tr", "bl", "br", "h", "v")

    def __init__(self, tl: str, tr: str, bl: str, br: str, h: str, v: str) -> None:
        self.tl, self.tr, self.bl, self.br, self.h, self.v = tl, tr, bl, br, h, v


_BORDER_STYLES: dict[str, _BorderChars] = {
    "single": _BorderChars("┌", "┐", "└", "┘", "─", "│"),
    "double": _BorderChars("╔", "╗", "╚", "╝", "═", "║"),
    "round":  _BorderChars("╭", "╮", "╰", "╯", "─", "│"),
    "bold":   _BorderChars("┏", "┓", "┗", "┛", "━", "┃"),
}

_NAMED_COLORS: dict[str, int] = {
    "red":     0xFF0000,
    "green":   0x00FF00,
    "blue":    0x0000FF,
    "yellow":  0xFFFF00,
    "cyan":    0x00FFFF,
    "magenta": 0xFF00FF,
    "white":   0xFFFFFF,
    "gray":    0x808080,
}


def _parse_color(value: Any) -> Optional[Color]:
    if value is None:
        return None
    if isinstance(value, str):
        if value.startswith("#") and len(value) in (7, 9):
            try:
                n = int(value[1:7], 16)
                return Color(ColorMode.RGB, n)
            except ValueError:
                pass
        named = _NAMED_COLORS.get(value.lower())
        if named is not None:
            return Color(ColorMode.RGB, named)
    return None


class _StyleContext:
    __slots__ = ("fg", "bg", "bold", "dim", "italic", "underline", "strikethrough", "inverse")

    def __init__(self) -> None:
        self.fg: Optional[Color] = None
        self.bg: Optional[Color] = None
        self.bold: Optional[bool] = None
        self.dim: Optional[bool] = None
        self.italic: Optional[bool] = None
        self.underline: Optional[bool] = None
        self.strikethrough: Optional[bool] = None
        self.inverse: Optional[bool] = None

    def copy(self) -> _StyleContext:
        ctx = _StyleContext()
        ctx.fg = Color(self.fg.mode, self.fg.value) if self.fg else None
        ctx.bg = Color(self.bg.mode, self.bg.value) if self.bg else None
        ctx.bold = self.bold
        ctx.dim = self.dim
        ctx.italic = self.italic
        ctx.underline = self.underline
        ctx.strikethrough = self.strikethrough
        ctx.inverse = self.inverse
        return ctx


def _merge_style(inherited: _StyleContext, props: dict[str, Any]) -> _StyleContext:
    ctx = inherited.copy()
    fg = _parse_color(props.get("fg")) or _parse_color(props.get("color"))
    if fg:
        ctx.fg = fg
    bg = _parse_color(props.get("backgroundColor"))
    if bg:
        ctx.bg = bg
    if props.get("bold") is not None:
        ctx.bold = props["bold"]
    if props.get("dim") is not None:
        ctx.dim = props["dim"]
    if props.get("italic") is not None:
        ctx.italic = props["italic"]
    if props.get("underline") is not None:
        ctx.underline = props["underline"]
    if props.get("strikethrough") is not None:
        ctx.strikethrough = props["strikethrough"]
    if props.get("inverse") is not None:
        ctx.inverse = props["inverse"]
    return ctx


def _merge_segment_style(base: _StyleContext, seg: SegmentStyle) -> _StyleContext:
    ctx = base.copy()
    fg = _parse_color(seg.color) or _parse_color(seg.fg)
    if fg:
        ctx.fg = fg
    bg = _parse_color(seg.background_color)
    if bg:
        ctx.bg = bg
    if seg.bold is not None:
        ctx.bold = seg.bold
    if seg.dim is not None:
        ctx.dim = seg.dim
    if seg.italic is not None:
        ctx.italic = seg.italic
    if seg.underline is not None:
        ctx.underline = seg.underline
    if seg.strikethrough is not None:
        ctx.strikethrough = seg.strikethrough
    if seg.inverse is not None:
        ctx.inverse = seg.inverse
    return ctx


def _style_attrs(ctx: _StyleContext) -> int:
    a = 0
    if ctx.bold:        a |= Attr.Bold
    if ctx.dim:         a |= Attr.Dim
    if ctx.italic:      a |= Attr.Italic
    if ctx.underline:   a |= Attr.Underline
    if ctx.strikethrough: a |= Attr.Strikethrough
    if ctx.inverse:     a |= Attr.Inverse
    return a


def rasterize(
    root: TNode,
    width: int,
    height: int,
    scroll_offset: int = 0,
) -> CellGrid:
    grid = create_grid(width, height)
    _walk_node(root, _StyleContext(), grid, scroll_offset, False)
    return grid


def _walk_node(
    node: TNode,
    inherited: _StyleContext,
    grid: CellGrid,
    scroll_offset: int,
    skip_scroll_offset: bool,
) -> None:
    if not node.layout:
        return
    if node.props.get("display") == "none":
        return

    l = node.layout
    effective_offset = 0 if skip_scroll_offset else scroll_offset

    if node.type != "root":
        if l.y + l.height <= effective_offset:
            return  # entirely above viewport
        if l.y - effective_offset >= grid.height:
            return  # entirely below viewport

    style = _merge_style(inherited, node.props)

    if node.type == "text":
        _rasterize_text(node, style, grid, effective_offset)
        return

    if node.type == "divider":
        row = l.y - effective_offset
        if row < 0 or row >= grid.height:
            return
        char = node.props.get("char", "─")
        fg = _parse_color(node.props.get("color")) or style.fg
        attrs = _style_attrs(style)
        for c in range(l.x, min(l.x + l.width, grid.width)):
            cell = grid.cells[row][c]
            cell.char = char
            cell.width = 1
            if fg:
                cell.fg = Color(fg.mode, fg.value)
            cell.attrs = attrs
        return

    # Box or root: fill background, draw border, recurse children
    if node.props.get("backgroundColor"):
        bg_color = _parse_color(node.props["backgroundColor"])
        if bg_color:
            _fill_background(node, bg_color, grid, effective_offset)

    if node.props.get("borderStyle"):
        _draw_border(node, style, grid, effective_offset)

    for child in node.children:
        _walk_node(child, style, grid, scroll_offset, skip_scroll_offset)


def _draw_border(
    node: TNode,
    style: _StyleContext,
    grid: CellGrid,
    scroll_offset: int,
) -> None:
    l = node.layout
    assert l is not None
    chars = _BORDER_STYLES.get(node.props.get("borderStyle", ""))
    if not chars:
        return

    fg = _parse_color(node.props.get("borderColor")) or style.fg
    bg = style.bg or _parse_color(node.props.get("backgroundColor"))

    top_row    = l.y - scroll_offset
    bottom_row = l.y + l.height - 1 - scroll_offset
    left_col   = l.x
    right_col  = l.x + l.width - 1

    def set_cell(row: int, col: int, ch: str) -> None:
        if row < 0 or row >= grid.height or col < 0 or col >= grid.width:
            return
        cell = grid.cells[row][col]
        cell.char = ch
        cell.width = 1
        if fg:
            cell.fg = Color(fg.mode, fg.value)
        if bg:
            cell.bg = Color(bg.mode, bg.value)

    # Top edge
    if 0 <= top_row < grid.height:
        set_cell(top_row, left_col, chars.tl)
        for c in range(left_col + 1, right_col):
            set_cell(top_row, c, chars.h)
        set_cell(top_row, right_col, chars.tr)

    # Bottom edge
    if 0 <= bottom_row < grid.height:
        set_cell(bottom_row, left_col, chars.bl)
        for c in range(left_col + 1, right_col):
            set_cell(bottom_row, c, chars.h)
        set_cell(bottom_row, right_col, chars.br)

    # Left and right edges
    for r in range(top_row + 1, bottom_row):
        if r < 0 or r >= grid.height:
            continue
        set_cell(r, left_col, chars.v)
        set_cell(r, right_col, chars.v)


def _fill_background(
    node: TNode,
    bg: Color,
    grid: CellGrid,
    scroll_offset: int,
) -> None:
    l = node.layout
    assert l is not None
    start_row = max(l.y - scroll_offset, 0)
    end_row   = min(l.y + l.height - scroll_offset, grid.height)
    for row in range(start_row, end_row):
        for col in range(l.x, min(l.x + l.width, grid.width)):
            grid.cells[row][col].bg = Color(bg.mode, bg.value)


def _rasterize_text(
    node: TNode,
    style: _StyleContext,
    grid: CellGrid,
    scroll_offset: int,
) -> None:
    l = node.layout
    assert l is not None
    lines = l.wrapped_lines
    if not lines:
        return

    bg = style.bg or _parse_color(node.props.get("backgroundColor"))

    # Fill background for entire text rect if bg is set
    if bg:
        start_row = max(l.y - scroll_offset, 0)
        end_row   = min(l.y + l.height - scroll_offset, grid.height)
        for row in range(start_row, end_row):
            for col in range(l.x, min(l.x + l.width, grid.width)):
                grid.cells[row][col].bg = Color(bg.mode, bg.value)

    hanging_indent = l.hanging_indent or 0
    clipped_lines = max(scroll_offset - l.y, 0)
    text_align = l.text_align

    for i in range(clipped_lines, len(lines)):
        row = l.y + i - scroll_offset
        if row >= grid.height:
            break
        if row < 0:
            continue

        x_base = l.x if i == 0 else l.x + hanging_indent
        line = lines[i]

        # Per-line alignment offset
        x_start = x_base
        if text_align in ("center", "right"):
            line_len = sum(string_display_width(run.text) for run in line)
            slack = l.width - line_len - (0 if i == 0 else hanging_indent)
            if slack > 0:
                x_start += slack // 2 if text_align == "center" else slack

        col = x_start
        prev_cell: Optional[Cell] = None

        for run in line:
            run_style = _merge_segment_style(style, run.style) if run.style else style
            run_fg = run_style.fg
            run_attrs = _style_attrs(run_style)

            prev_was_zwj = False
            prev_was_ri = False

            for ch in run.text:
                cp = ord(ch)
                w = char_display_width(cp)

                cluster_append = False
                if w == 2 and prev_cell is not None:
                    if is_skin_tone_modifier(cp) and prev_cell.width == 2:
                        cluster_append = True
                    elif is_regional_indicator(cp) and prev_was_ri:
                        cluster_append = True
                    elif prev_was_zwj:
                        cluster_append = True

                if cluster_append:
                    prev_cell.char += ch
                    prev_was_zwj = False
                    prev_was_ri = False
                    continue

                if w == 0:
                    # Combining mark / ZWJ / variation selector: attach to previous cell
                    if prev_cell is not None:
                        prev_cell.char += ch
                        # VS16 (U+FE0F) upgrades text-presentation emoji to width 2
                        if cp == 0xFE0F and prev_cell.width == 1 and col < grid.width:
                            base_cp = ord(prev_cell.char[0])
                            if is_text_presentation_emoji(base_cp):
                                prev_cell.width = 2
                                cont = grid.cells[row][col]
                                cont.char = ""
                                cont.width = 0
                                cont.attrs = run_attrs
                                if run_fg:
                                    cont.fg = Color(run_fg.mode, run_fg.value)
                                if bg:
                                    cont.bg = Color(bg.mode, bg.value)
                                col += 1
                    prev_was_zwj = (cp == 0x200D)
                    prev_was_ri = False
                    continue

                if w == 2 and col + 2 > grid.width:
                    break
                if col >= grid.width:
                    break

                cell = grid.cells[row][col]
                cell.char = ch
                cell.width = w
                cell.attrs = run_attrs
                if run_fg:
                    cell.fg = Color(run_fg.mode, run_fg.value)
                if bg:
                    cell.bg = Color(bg.mode, bg.value)
                prev_cell = cell

                if w == 2 and col + 1 < grid.width:
                    cont = grid.cells[row][col + 1]
                    cont.char = ""
                    cont.width = 0
                    cont.attrs = run_attrs
                    if run_fg:
                        cont.fg = Color(run_fg.mode, run_fg.value)
                    if bg:
                        cont.bg = Color(bg.mode, bg.value)

                col += w
                prev_was_zwj = False
                prev_was_ri = is_regional_indicator(cp)
