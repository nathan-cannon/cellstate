"""High-level render_once() entry point."""

from __future__ import annotations
import os
from typing import Optional

from .nodes import TNode
from .layout import layout, content_height
from .rasterizer import rasterize
from .diff import serialize_rows_reflow


def render_once(root: TNode, columns: Optional[int] = None) -> str:
    """
    Run the full pipeline once and return a styled ANSI string.
    Uses real newlines so the output is safe to print or pipe.

    Args:
        root:    The root TNode produced by create_node('root') + append_child calls.
        columns: Terminal width in columns. Defaults to the current terminal width
                 (os.get_terminal_size) or 80.

    Returns:
        An ANSI-escaped string ready to be printed to stdout.
    """
    if columns is None:
        try:
            columns = os.get_terminal_size().columns
        except OSError:
            columns = 80

    layout(root, columns, 1000)

    ch = content_height(root)
    if ch <= 0:
        return ""

    grid = rasterize(root, columns, ch, 0)
    result = serialize_rows_reflow(grid)
    return result.output
