"""
cellstate — Python terminal renderer with cell-level diffing.

Ported from the TypeScript cellstate library. The React reconciler layer is
replaced by a direct tree-building API: use create_node / append_child to
build a TNode tree, then call render_once() to get an ANSI string.

Quick start::

    from cellstate import create_node, append_child, render_once

    root = create_node('root')
    box  = create_node('box', {'borderStyle': 'round', 'padding': 1})
    text = create_node('text')
    text.text = 'Hello, World!'
    append_child(box, text)
    append_child(root, box)

    print(render_once(root, columns=40))

Supported box props:
    borderStyle      'single' | 'double' | 'round' | 'bold'
    padding          int
    paddingTop/Bottom/Left/Right  int
    margin           int
    marginTop/Bottom/Left/Right   int
    flexDirection    'column' (default) | 'row'
    flexGrow         truthy → expand to fill remaining row space
    width / height   int
    gap              int
    justifyContent   'flex-start' | 'flex-end' | 'center' |
                     'space-between' | 'space-around' | 'space-evenly'
    alignItems       'stretch' | 'flex-start' | 'center' | 'flex-end'
    backgroundColor  '#RRGGBB' or color name
    display          'none' to hide

Supported text props (also work on box for inherited styling):
    bold / italic / underline / strikethrough / dim / inverse  bool
    fg / color       '#RRGGBB' or color name
    backgroundColor  '#RRGGBB' or color name
    wrap             'wrap' (default) | 'truncate' | 'truncate-end' |
                     'truncate-start' | 'truncate-middle'
    hangingIndent    int
    segments         list of Segment objects for mixed styled text

Divider props:
    char   character to repeat (default '─')
    color  foreground color
"""

from .cell import ColorMode, Attr, Color, Cell, CellGrid, create_grid, colors_equal, cells_equal, grid_to_debug_string
from .nodes import (
    SegmentStyle, Segment, StyledRun, WrappedLine,
    LayoutResult, TNode,
    create_node, append_child, remove_child, insert_before,
)
from .layout import layout, content_height, wrap_text, wrap_segments, clear_layout
from .rasterizer import rasterize
from .diff import (
    DiffResult,
    last_content_row, style_to_ansi, style_delta,
    serialize_rows, serialize_rows_reflow, serialize_row_range,
    full_redraw, extract_viewport, diff,
)
from .renderer import render_once

__all__ = [
    # High-level
    "render_once",
    # Node tree
    "create_node", "append_child", "remove_child", "insert_before",
    "TNode", "SegmentStyle", "Segment", "StyledRun", "WrappedLine", "LayoutResult",
    # Layout
    "layout", "content_height", "wrap_text", "wrap_segments", "clear_layout",
    # Rasterizer
    "rasterize",
    # Diff / ANSI
    "DiffResult", "diff", "full_redraw",
    "serialize_rows", "serialize_rows_reflow", "serialize_row_range",
    "last_content_row", "style_to_ansi", "style_delta", "extract_viewport",
    # Cell primitives
    "ColorMode", "Attr", "Color", "Cell", "CellGrid",
    "create_grid", "colors_equal", "cells_equal", "grid_to_debug_string",
]
