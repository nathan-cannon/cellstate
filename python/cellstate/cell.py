"""
Cell grid primitives. A CellGrid is the shared data structure between the
rasterizer (writes cells) and the diff engine (reads cells to produce ANSI).
"""

from __future__ import annotations
from dataclasses import dataclass, field
from enum import IntEnum


class ColorMode(IntEnum):
    """
    Color mode matches xterm's internal representation:
      0 = default (terminal's default fg/bg)
      1 = palette (16 basic + 256 extended colors, value 0-255)
      2 = rgb (24-bit truecolor, value = r<<16 | g<<8 | b)
    """
    Default = 0
    Palette = 1
    RGB = 2


class Attr(IntEnum):
    """Attribute bit flags."""
    Bold          = 1
    Italic        = 2
    Underline     = 4
    Strikethrough = 8
    Dim           = 16
    Inverse       = 32


@dataclass
class Color:
    mode: ColorMode = ColorMode.Default
    value: int = 0  # palette index (0-255) or 0xRRGGBB

    def copy(self) -> Color:
        return Color(self.mode, self.value)


DEFAULT_COLOR = Color(ColorMode.Default, 0)


@dataclass
class Cell:
    char: str = " "   # single character (' ' for empty), or '' for wide-char continuation
    width: int = 1    # 0 = continuation, 1 = normal, 2 = wide
    fg: Color = field(default_factory=lambda: Color(ColorMode.Default, 0))
    bg: Color = field(default_factory=lambda: Color(ColorMode.Default, 0))
    attrs: int = 0    # bitmask of Attr flags


@dataclass
class CellGrid:
    cells: list[list[Cell]]  # rows × cols
    cursor_row: int
    cursor_col: int
    width: int
    height: int


def _empty_cell() -> Cell:
    return Cell(char=" ", width=1, fg=Color(), bg=Color(), attrs=0)


def create_grid(width: int, height: int) -> CellGrid:
    cells: list[list[Cell]] = []
    for _ in range(height):
        row: list[Cell] = [_empty_cell() for _ in range(width)]
        cells.append(row)
    return CellGrid(cells=cells, cursor_row=0, cursor_col=0, width=width, height=height)


def colors_equal(a: Color, b: Color) -> bool:
    return a.mode == b.mode and a.value == b.value


def cells_equal(a: Cell, b: Cell) -> bool:
    return (
        a.char == b.char
        and a.width == b.width
        and a.attrs == b.attrs
        and colors_equal(a.fg, b.fg)
        and colors_equal(a.bg, b.bg)
    )


def grid_to_debug_string(grid: CellGrid) -> str:
    """Render grid as plain text (for debugging)."""
    lines = []
    for row in grid.cells:
        line = "".join(c.char or " " for c in row).rstrip()
        lines.append(line)
    return "\n".join(lines)
