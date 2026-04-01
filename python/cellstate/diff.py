"""
Cell-level diff engine and ANSI serialization.

Compares two CellGrids and emits minimal ANSI to transform one into the other.
Only uses relative cursor movements (CUU/CUD/CHA), not absolute CUP, so the
output works in inline mode without an alternate screen.
"""

from __future__ import annotations
import os
from dataclasses import dataclass
from typing import Optional

from .cell import Cell, CellGrid, Color, ColorMode, DEFAULT_COLOR, create_grid, colors_equal, cells_equal

ESC = "\x1b["


def last_content_row(grid: CellGrid) -> int:
    """Find the last row that contains non-default content."""
    for r in range(grid.height - 1, -1, -1):
        for c in range(grid.width):
            cell = grid.cells[r][c]
            if (cell.char != " "
                    or cell.fg.mode != ColorMode.Default
                    or cell.bg.mode != ColorMode.Default
                    or cell.attrs != 0):
                return r
    return 0


def style_to_ansi(fg: Color, bg: Color, attrs: int) -> str:
    """Convert our Color + attrs into an SGR escape sequence string."""
    parts: list[str] = []

    if attrs & 1:  parts.append("1")   # bold
    if attrs & 16: parts.append("2")   # dim
    if attrs & 2:  parts.append("3")   # italic
    if attrs & 4:  parts.append("4")   # underline
    if attrs & 32: parts.append("7")   # inverse
    if attrs & 8:  parts.append("9")   # strikethrough

    # Foreground
    if fg.mode == ColorMode.Default:
        parts.append("39")
    elif fg.mode == ColorMode.Palette:
        parts.append(f"38;5;{fg.value}")
    else:
        r = (fg.value >> 16) & 0xFF
        g = (fg.value >> 8) & 0xFF
        b = fg.value & 0xFF
        parts.append(f"38;2;{r};{g};{b}")

    # Background
    if bg.mode == ColorMode.Default:
        parts.append("49")
    elif bg.mode == ColorMode.Palette:
        parts.append(f"48;5;{bg.value}")
    else:
        r = (bg.value >> 16) & 0xFF
        g = (bg.value >> 8) & 0xFF
        b = bg.value & 0xFF
        parts.append(f"48;2;{r};{g};{b}")

    return f"{ESC}{';'.join(parts)}m"


def _style_matches(
    fg: Color, bg: Color, attrs: int,
    cur_fg: Color, cur_bg: Color, cur_attrs: int,
) -> bool:
    return attrs == cur_attrs and colors_equal(fg, cur_fg) and colors_equal(bg, cur_bg)


def _color_sgr_params(color: Color, fg_or_bg: str) -> str:
    if color.mode == ColorMode.Default:
        return "39" if fg_or_bg == "fg" else "49"
    elif color.mode == ColorMode.Palette:
        return f"38;5;{color.value}" if fg_or_bg == "fg" else f"48;5;{color.value}"
    else:
        r = (color.value >> 16) & 0xFF
        g = (color.value >> 8) & 0xFF
        b = color.value & 0xFF
        if fg_or_bg == "fg":
            return f"38;2;{r};{g};{b}"
        return f"48;2;{r};{g};{b}"


def style_delta(
    from_fg: Color, from_bg: Color, from_attrs: int,
    to_fg: Color, to_bg: Color, to_attrs: int,
) -> str:
    """
    Compute the minimal SGR escape sequence to transition from one style to another.
    Returns empty string if styles are identical.
    """
    if from_attrs == to_attrs and colors_equal(from_fg, to_fg) and colors_equal(from_bg, to_bg):
        return ""

    to_is_default = (to_attrs == 0
                     and to_fg.mode == ColorMode.Default
                     and to_bg.mode == ColorMode.Default)

    if to_is_default:
        return f"{ESC}0m"

    # Fast path: fg-only change
    if from_attrs == to_attrs and colors_equal(from_bg, to_bg):
        return f"{ESC}{_color_sgr_params(to_fg, 'fg')}m"

    # Fast path: bg-only change
    if from_attrs == to_attrs and colors_equal(from_fg, to_fg):
        return f"{ESC}{_color_sgr_params(to_bg, 'bg')}m"

    # Fast path: from default
    if from_attrs == 0 and from_fg.mode == ColorMode.Default and from_bg.mode == ColorMode.Default:
        return style_to_ansi(to_fg, to_bg, to_attrs)

    # General case
    delta = ""

    added   = to_attrs & ~from_attrs
    removed = from_attrs & ~to_attrs

    # Bold (1) and Dim (16) share the same turn-off code (SGR 22).
    removed_bold_dim = removed & 0x11
    if removed_bold_dim:
        delta = "22"
        if (to_attrs & 0x01) and (removed_bold_dim & 0x10):
            delta += ";1"
        if (to_attrs & 0x10) and (removed_bold_dim & 0x01):
            delta += ";2"

    if removed & 0x02: delta += (";23" if delta else "23")
    if removed & 0x04: delta += (";24" if delta else "24")
    if removed & 0x08: delta += (";29" if delta else "29")
    if removed & 0x20: delta += (";27" if delta else "27")

    if (added & 0x01) and not removed_bold_dim: delta += (";1" if delta else "1")
    if (added & 0x10) and not removed_bold_dim: delta += (";2" if delta else "2")
    if added & 0x02: delta += (";3" if delta else "3")
    if added & 0x04: delta += (";4" if delta else "4")
    if added & 0x08: delta += (";9" if delta else "9")
    if added & 0x20: delta += (";7" if delta else "7")

    if not colors_equal(from_fg, to_fg):
        p = _color_sgr_params(to_fg, "fg")
        delta += (";" + p if delta else p)
    if not colors_equal(from_bg, to_bg):
        p = _color_sgr_params(to_bg, "bg")
        delta += (";" + p if delta else p)

    delta_seq = f"{ESC}{delta}m" if delta else ""

    # Reset path
    reset = "0"
    if to_attrs & 0x01: reset += ";1"
    if to_attrs & 0x10: reset += ";2"
    if to_attrs & 0x02: reset += ";3"
    if to_attrs & 0x04: reset += ";4"
    if to_attrs & 0x20: reset += ";7"
    if to_attrs & 0x08: reset += ";9"
    if to_fg.mode != ColorMode.Default: reset += ";" + _color_sgr_params(to_fg, "fg")
    if to_bg.mode != ColorMode.Default: reset += ";" + _color_sgr_params(to_bg, "bg")
    reset_seq = f"{ESC}{reset}m"

    return delta_seq if len(delta_seq) <= len(reset_seq) else reset_seq


def _move_cursor(from_row: int, from_col: int, to_row: int, to_col: int) -> str:
    """Emit relative cursor movement. Uses CUU/CUD for vertical, CHA for horizontal."""
    seq = ""
    d_row = to_row - from_row
    if d_row < 0:
        seq += f"{ESC}{-d_row}A"
    elif d_row > 0:
        seq += f"{ESC}{d_row}B"
    if to_col != from_col:
        seq += f"{ESC}{to_col + 1}G"
    return seq


@dataclass
class DiffResult:
    output: str
    end_row: int
    end_col: int


def _last_content_col(grid: CellGrid, row: int) -> int:
    for c in range(grid.width - 1, -1, -1):
        cell = grid.cells[row][c]
        if (cell.char != " " or cell.width != 1
                or cell.fg.mode != ColorMode.Default
                or cell.bg.mode != ColorMode.Default
                or cell.attrs != 0):
            return c
    return -1


def _is_blank_from(grid: CellGrid, row: int, start_col: int, width: int) -> bool:
    for c in range(start_col, width):
        cell = grid.cells[row][c]
        if (cell.char != " " or cell.width != 1
                or cell.fg.mode != ColorMode.Default
                or cell.bg.mode != ColorMode.Default
                or cell.attrs != 0):
            return False
    return True


def _is_blank_row(grid: CellGrid, row: int, width: int) -> bool:
    for c in range(width):
        cell = grid.cells[row][c]
        if (cell.char != " " or cell.width != 1
                or cell.fg.mode != ColorMode.Default
                or cell.bg.mode != ColorMode.Default
                or cell.attrs != 0):
            return False
    return True


def _rows_equal(prev: CellGrid, next_g: CellGrid, row: int, width: int) -> bool:
    for c in range(width):
        if not cells_equal(prev.cells[row][c], next_g.cells[row][c]):
            return False
    return True


def _serialize_rows_core(
    grid: CellGrid,
    emit_row_separator,  # callable(cur_fg, cur_bg, cur_attrs) -> (seq, fg, bg, attrs)
    trim_trailing: bool = False,
) -> DiffResult:
    out = ""
    cur_row = 0
    cur_col = 0
    cur_fg  = Color(ColorMode.Default, 0)
    cur_bg  = Color(ColorMode.Default, 0)
    cur_attrs = 0

    last_row = last_content_row(grid)

    for r in range(last_row + 1):
        if r > 0:
            seq, cur_fg, cur_bg, cur_attrs = emit_row_separator(cur_fg, cur_bg, cur_attrs)
            out += seq
            cur_row = r
            cur_col = 0

        col_end = _last_content_col(grid, r) if trim_trailing else grid.width - 1

        for c in range(col_end + 1):
            cell = grid.cells[r][c]
            if cell.width == 0:
                continue
            if not _style_matches(cell.fg, cell.bg, cell.attrs, cur_fg, cur_bg, cur_attrs):
                out += style_delta(cur_fg, cur_bg, cur_attrs, cell.fg, cell.bg, cell.attrs)
                cur_fg    = Color(cell.fg.mode, cell.fg.value)
                cur_bg    = Color(cell.bg.mode, cell.bg.value)
                cur_attrs = cell.attrs
            out += cell.char
            cur_col += cell.width

    if out and (cur_attrs != 0
                or cur_fg.mode != ColorMode.Default
                or cur_bg.mode != ColorMode.Default):
        out += f"{ESC}0m"

    return DiffResult(output=out, end_row=cur_row, end_col=cur_col)


def serialize_rows(grid: CellGrid) -> DiffResult:
    """Serialize grid rows using pending-wrap row advancement (space+backspace)."""
    def emit_sep(cur_fg, cur_bg, cur_attrs):
        return " \x08", cur_fg, cur_bg, cur_attrs
    return _serialize_rows_core(grid, emit_sep)


def serialize_rows_reflow(grid: CellGrid) -> DiffResult:
    """
    Like serialize_rows but uses real newlines. Resets SGR before each newline
    to prevent background color bleed on reflow. Used for static rendering.
    """
    def emit_sep(cur_fg, cur_bg, cur_attrs):
        has_style = (cur_attrs != 0
                     or cur_fg.mode != ColorMode.Default
                     or cur_bg.mode != ColorMode.Default)
        seq = (f"{ESC}0m" if has_style else "") + "\n"
        if has_style:
            return seq, Color(ColorMode.Default, 0), Color(ColorMode.Default, 0), 0
        return seq, cur_fg, cur_bg, cur_attrs
    return _serialize_rows_core(grid, emit_sep, trim_trailing=True)


def _serialize_rows_full(grid: CellGrid) -> DiffResult:
    """Write ALL rows and erase each line before writing."""
    out = ""
    cur_row = 0
    cur_col = 0
    cur_fg    = Color(ColorMode.Default, 0)
    cur_bg    = Color(ColorMode.Default, 0)
    cur_attrs = 0

    for r in range(grid.height):
        if r > 0:
            if (cur_attrs != 0
                    or cur_fg.mode != ColorMode.Default
                    or cur_bg.mode != ColorMode.Default):
                out += f"{ESC}0m"
                cur_fg    = Color(ColorMode.Default, 0)
                cur_bg    = Color(ColorMode.Default, 0)
                cur_attrs = 0
            out += " \x08"
            cur_row = r
            cur_col = 0

        out += f"{ESC}2K"

        for c in range(grid.width):
            cell = grid.cells[r][c]
            if cell.width == 0:
                continue
            if not _style_matches(cell.fg, cell.bg, cell.attrs, cur_fg, cur_bg, cur_attrs):
                out += style_delta(cur_fg, cur_bg, cur_attrs, cell.fg, cell.bg, cell.attrs)
                cur_fg    = Color(cell.fg.mode, cell.fg.value)
                cur_bg    = Color(cell.bg.mode, cell.bg.value)
                cur_attrs = cell.attrs
            out += cell.char
            cur_col += cell.width

    if out and (cur_attrs != 0
                or cur_fg.mode != ColorMode.Default
                or cur_bg.mode != ColorMode.Default):
        out += f"{ESC}0m"

    return DiffResult(output=out, end_row=cur_row, end_col=cur_col)


def full_redraw(grid: CellGrid, cursor_start_row: Optional[int] = None) -> DiffResult:
    if cursor_start_row is None:
        cursor_start_row = grid.height - 1

    preamble = f"{ESC}0m"
    if cursor_start_row > 0:
        preamble += f"{ESC}{cursor_start_row}A"
    preamble += f"{ESC}G"

    body = _serialize_rows_full(grid)
    return DiffResult(
        output=preamble + body.output,
        end_row=body.end_row,
        end_col=body.end_col,
    )


def serialize_row_range(grid: CellGrid, start_row: int, end_row: int) -> DiffResult:
    """Emit rows start_row through end_row-1 using pending-wrap advancement."""
    out = ""
    cur_row = 0
    cur_col = 0
    cur_fg    = Color(ColorMode.Default, 0)
    cur_bg    = Color(ColorMode.Default, 0)
    cur_attrs = 0

    for r in range(start_row, end_row):
        rel_row = r - start_row
        if rel_row > 0:
            out += " \x08"
            cur_row = rel_row
            cur_col = 0

        for c in range(grid.width):
            cell = grid.cells[r][c]
            if cell.width == 0:
                continue
            if not _style_matches(cell.fg, cell.bg, cell.attrs, cur_fg, cur_bg, cur_attrs):
                out += style_delta(cur_fg, cur_bg, cur_attrs, cell.fg, cell.bg, cell.attrs)
                cur_fg    = Color(cell.fg.mode, cell.fg.value)
                cur_bg    = Color(cell.bg.mode, cell.bg.value)
                cur_attrs = cell.attrs
            out += cell.char
            cur_col += cell.width

    if out and (cur_attrs != 0
                or cur_fg.mode != ColorMode.Default
                or cur_bg.mode != ColorMode.Default):
        out += f"{ESC}0m"

    return DiffResult(output=out, end_row=cur_row, end_col=cur_col)


def extract_viewport(full_grid: CellGrid, scroll_offset: int, viewport_rows: int) -> CellGrid:
    result = create_grid(full_grid.width, viewport_rows)
    for r in range(viewport_rows):
        src_row = scroll_offset + r
        if src_row < full_grid.height:
            for c in range(full_grid.width):
                src = full_grid.cells[src_row][c]
                dst = result.cells[r][c]
                dst.char  = src.char
                dst.width = src.width
                dst.fg    = Color(src.fg.mode, src.fg.value)
                dst.bg    = Color(src.bg.mode, src.bg.value)
                dst.attrs = src.attrs
    return result


def diff(
    prev: CellGrid,
    next_g: CellGrid,
    start_row: Optional[int] = None,
    start_col: Optional[int] = None,
) -> DiffResult:
    """
    Diff two CellGrids and return minimal ANSI escape sequences to transform
    prev into next. Uses only relative cursor movements (CUU/CUD/CHA).
    Grids must have the same dimensions.
    """
    if prev.width != next_g.width or prev.height != next_g.height:
        return full_redraw(next_g)

    width  = next_g.width
    height = next_g.height
    out    = ""
    skipped_rows  = 0
    erased_rows   = 0
    erased_trailing = 0

    cur_row   = start_row if start_row is not None else prev.cursor_row
    cur_col   = start_col if start_col is not None else prev.cursor_col
    cur_fg    = Color(ColorMode.Default, 0)
    cur_bg    = Color(ColorMode.Default, 0)
    cur_attrs = 0
    style_known = False

    for r in range(height):
        if _rows_equal(prev, next_g, r, width):
            skipped_rows += 1
            continue

        if _is_blank_row(next_g, r, width):
            if cur_row != r or cur_col != 0:
                out += _move_cursor(cur_row, cur_col, r, 0)
                cur_row = r
                cur_col = 0
            if not style_known or cur_bg.mode != ColorMode.Default:
                out += f"{ESC}0m"
                cur_fg    = Color(ColorMode.Default, 0)
                cur_bg    = Color(ColorMode.Default, 0)
                cur_attrs = 0
            style_known = True
            out += f"{ESC}2K"
            erased_rows += 1
            continue

        for c in range(width):
            p_cell = prev.cells[r][c]
            n_cell = next_g.cells[r][c]

            if n_cell.width == 0:
                continue

            if cells_equal(p_cell, n_cell):
                if n_cell.width > 1 and c + 1 < width:
                    if cells_equal(prev.cells[r][c + 1], next_g.cells[r][c + 1]):
                        continue
                else:
                    continue

            # Erase-to-end optimisation
            if (n_cell.char == " " and n_cell.width == 1
                    and n_cell.fg.mode == ColorMode.Default
                    and n_cell.bg.mode == ColorMode.Default
                    and n_cell.attrs == 0
                    and _is_blank_from(next_g, r, c, width)):
                if cur_row != r or cur_col != c:
                    out += _move_cursor(cur_row, cur_col, r, c)
                    cur_row = r
                    cur_col = c
                if not style_known or cur_bg.mode != ColorMode.Default:
                    out += f"{ESC}0m"
                    cur_fg    = Color(ColorMode.Default, 0)
                    cur_bg    = Color(ColorMode.Default, 0)
                    cur_attrs = 0
                style_known = True
                out += f"{ESC}0K"
                erased_trailing += 1
                break

            if cur_row != r or cur_col != c:
                out += _move_cursor(cur_row, cur_col, r, c)
                cur_row = r
                cur_col = c

            if not style_known:
                out += f"{ESC}0m"
                if (n_cell.attrs != 0
                        or n_cell.fg.mode != ColorMode.Default
                        or n_cell.bg.mode != ColorMode.Default):
                    out += style_to_ansi(n_cell.fg, n_cell.bg, n_cell.attrs)
                cur_fg    = Color(n_cell.fg.mode, n_cell.fg.value)
                cur_bg    = Color(n_cell.bg.mode, n_cell.bg.value)
                cur_attrs = n_cell.attrs
                style_known = True
            elif not _style_matches(n_cell.fg, n_cell.bg, n_cell.attrs, cur_fg, cur_bg, cur_attrs):
                out += style_delta(cur_fg, cur_bg, cur_attrs, n_cell.fg, n_cell.bg, n_cell.attrs)
                cur_fg    = Color(n_cell.fg.mode, n_cell.fg.value)
                cur_bg    = Color(n_cell.bg.mode, n_cell.bg.value)
                cur_attrs = n_cell.attrs

            out += n_cell.char
            cur_col += n_cell.width

            # Clear orphaned continuation cell
            if n_cell.width == 1 and c + 1 < width and p_cell.width == 2:
                out += " "
                cur_col += 1

    if out and style_known and (cur_attrs != 0
            or cur_fg.mode != ColorMode.Default
            or cur_bg.mode != ColorMode.Default):
        out += f"{ESC}0m"

    if os.environ.get("DEBUG") and (skipped_rows or erased_rows or erased_trailing):
        import sys
        print(
            f"[DAMAGE] skipped={skipped_rows} erased={erased_rows} "
            f"trailingErase={erased_trailing} of {height} rows",
            file=sys.stderr,
        )

    return DiffResult(output=out, end_row=cur_row, end_col=cur_col)
