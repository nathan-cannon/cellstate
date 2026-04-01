"""
Flexbox-inspired layout engine. Computes position and size for every TNode.
All measurements are in terminal columns (display width), not string length.
"""

from __future__ import annotations
from typing import Any, Optional

from .nodes import TNode, Segment, WrappedLine, StyledRun, LayoutResult
from .width import (
    string_display_width, slice_to_width, slice_from_end_to_width,
    char_display_width, is_text_presentation_emoji,
    is_skin_tone_modifier, is_regional_indicator,
)


def _truncate_text(text: str, width: int, mode: str) -> str:
    if string_display_width(text) <= width:
        return text

    ellipsis = "\u2026"
    avail = width - 1

    if avail <= 0:
        return ellipsis[:width]

    if mode in ("truncate", "truncate-end"):
        return slice_to_width(text, avail) + ellipsis
    if mode == "truncate-start":
        return ellipsis + slice_from_end_to_width(text, avail)
    if mode == "truncate-middle":
        half = avail // 2
        end_len = avail - half
        return slice_to_width(text, half) + ellipsis + slice_from_end_to_width(text, end_len)
    return text


def _wrap_single_line(text: str, width: int, hanging_indent: int = 0) -> list[str]:
    """
    Wrap a single line of text (no \\n characters) at the given width.
    First wrapped line uses full width; continuation lines use width - hanging_indent.
    """
    lines: list[str] = []
    remaining = text
    is_first_line = True

    while remaining:
        line_width = width if is_first_line else max(width - hanging_indent, 1)

        if string_display_width(remaining) <= line_width:
            lines.append(remaining)
            break

        overflow_str_idx = 0
        cols = 0
        prev_cp: Optional[int] = None
        prev_was_zwj = False
        prev_was_ri = False
        cluster_start_str_idx = 0

        for ch in remaining:
            cp = ord(ch)
            w = char_display_width(cp)
            part_of_cluster = False

            if (cp == 0xFE0F and prev_cp is not None
                    and char_display_width(prev_cp) == 1
                    and is_text_presentation_emoji(prev_cp)):
                w = 1
                part_of_cluster = True
                if cols + w > line_width:
                    overflow_str_idx = cluster_start_str_idx
                    break
            elif is_skin_tone_modifier(cp) and prev_cp is not None and char_display_width(prev_cp) == 2:
                w = 0
                part_of_cluster = True
            elif is_regional_indicator(cp) and prev_was_ri:
                w = 0
                part_of_cluster = True
            elif prev_was_zwj and w == 2:
                w = 0
                part_of_cluster = True

            if cols + w > line_width:
                if part_of_cluster:
                    overflow_str_idx = cluster_start_str_idx
                break

            if not part_of_cluster:
                cluster_start_str_idx = overflow_str_idx

            cols += w
            overflow_str_idx += len(ch)
            prev_was_zwj = (cp == 0x200D)
            prev_was_ri = is_regional_indicator(cp) and not part_of_cluster
            prev_cp = cp

        # Guard: first character is wider than the line
        if overflow_str_idx == 0:
            first_char = next(iter(remaining))
            lines.append(first_char)
            remaining = remaining[len(first_char):]
            is_first_line = False
            continue

        # Backward pass: find a space to break at
        break_at = -1
        for i in range(overflow_str_idx, -1, -1):
            if i < len(remaining) and remaining[i] == " ":
                break_at = i
                break

        if break_at == -1:
            lines.append(remaining[:overflow_str_idx])
            remaining = remaining[overflow_str_idx:]
        else:
            lines.append(remaining[:break_at])
            remaining = remaining[break_at + 1:]

        is_first_line = False

    return lines


def wrap_text(text: str, width: int, hanging_indent: int = 0) -> list[str]:
    """
    Wrap text into lines at the given width.
    Embedded \\n characters produce forced line breaks.
    """
    if width <= 0 or not text:
        return []

    hard_lines = text.split("\n")
    result: list[str] = []

    for hard_line in hard_lines:
        if not hard_line:
            result.append("")
        else:
            result.extend(_wrap_single_line(hard_line, width, hanging_indent))

    return result


def wrap_segments(
    segments: list[Segment],
    width: int,
    hanging_indent: int = 0,
) -> list[WrappedLine]:
    """
    Wrap segments into styled lines. Uses wrap_text for break-point calculation
    on the concatenated plain text, then slices segments at those break points.
    """
    filtered = [s for s in segments if s.text]
    if not filtered or width <= 0:
        return []

    concat = "".join(s.text for s in filtered)
    if not concat:
        return []

    # Compute segment boundaries in the concatenated string
    bounds: list[dict] = []
    offset = 0
    for i, seg in enumerate(filtered):
        length = len(seg.text)
        bounds.append({"start": offset, "end": offset + length, "idx": i})
        offset += length

    plain_lines = wrap_text(concat, width, hanging_indent)
    if not plain_lines:
        return []

    result: list[WrappedLine] = []
    global_offset = 0

    for li, line in enumerate(plain_lines):
        line_start = global_offset
        line_end = line_start + len(line)

        runs: list[StyledRun] = []
        for b in bounds:
            if b["end"] <= line_start:
                continue
            if b["start"] >= line_end:
                break
            run_start = max(b["start"], line_start)
            run_end = min(b["end"], line_end)
            run_text = concat[run_start:run_end]
            if run_text:
                style = filtered[b["idx"]].style
                runs.append(StyledRun(text=run_text, style=style))

        result.append(runs)

        if li < len(plain_lines) - 1:
            if line_end < len(concat) and concat[line_end] in (" ", "\n"):
                global_offset = line_end + 1
            else:
                global_offset = line_end

    return result


def _resolve_margins(node: TNode) -> dict[str, int]:
    m = node.props.get("margin", 0)
    return {
        "top":    node.props.get("marginTop",    m),
        "bottom": node.props.get("marginBottom", m),
        "left":   node.props.get("marginLeft",   m),
        "right":  node.props.get("marginRight",  m),
    }


def _natural_width(node: TNode) -> int:
    if node.type == "text" and node.layout and node.layout.wrapped_lines:
        max_w = 0
        for line in node.layout.wrapped_lines:
            line_len = sum(string_display_width(run.text) for run in line)
            max_w = max(max_w, line_len)
        return max_w
    return node.layout.width if node.layout else 0


def _shift_node_x(node: TNode, dx: int) -> None:
    if not node.layout:
        return
    node.layout.x += dx
    for child in node.children:
        _shift_node_x(child, dx)


def _shift_node_y(node: TNode, dy: int) -> None:
    if not node.layout:
        return
    node.layout.y += dy
    for child in node.children:
        _shift_node_y(child, dy)


def _apply_justify_content(
    node: TNode,
    start_y: int,
    content_h: int,
    container_h: int,
) -> None:
    justify = node.props.get("justifyContent")
    if not justify or justify == "flex-start":
        return

    children = [c for c in node.children if c.layout and c.props.get("display") != "none"]
    if not children:
        return

    extra = container_h - content_h
    if extra <= 0:
        return

    offset = 0
    gap = 0.0

    if justify == "flex-end":
        offset = extra
    elif justify == "center":
        offset = extra // 2
    elif justify == "space-between":
        if len(children) > 1:
            gap = extra / (len(children) - 1)
    elif justify == "space-around":
        space = extra / len(children)
        offset = int(space / 2)
        gap = space
    elif justify == "space-evenly":
        space = extra / (len(children) + 1)
        offset = int(space)
        gap = space

    cumulative_gap = 0.0
    for child in children:
        shift = int(offset + cumulative_gap)
        if shift:
            _shift_node_y(child, shift)
        cumulative_gap += gap


def _apply_justify_content_row(
    node: TNode,
    start_x: int,
    content_w: int,
    container_w: int,
) -> None:
    justify = node.props.get("justifyContent")
    if not justify or justify == "flex-start":
        return

    children = [c for c in node.children if c.layout and c.props.get("display") != "none"]
    if not children:
        return

    extra = container_w - content_w
    if extra <= 0:
        return

    offset = 0
    gap = 0.0

    if justify == "flex-end":
        offset = extra
    elif justify == "center":
        offset = extra // 2
    elif justify == "space-between":
        if len(children) > 1:
            gap = extra / (len(children) - 1)
    elif justify == "space-around":
        space = extra / len(children)
        offset = int(space / 2)
        gap = space
    elif justify == "space-evenly":
        space = extra / (len(children) + 1)
        offset = int(space)
        gap = space

    cumulative_gap = 0.0
    for child in children:
        shift = int(offset + cumulative_gap)
        if shift:
            _shift_node_x(child, shift)
        cumulative_gap += gap


def _apply_alignment(align: Optional[str], child: TNode, child_width: int) -> None:
    if not align or align in ("stretch", "flex-start"):
        return

    if child.type == "text" and child.layout:
        child.layout.text_align = "center" if align == "center" else "right"
        return

    nw = _natural_width(child)
    slack = child_width - nw
    if slack <= 0:
        return

    dx = slack // 2 if align == "center" else slack  # flex-end
    _shift_node_x(child, dx)


def clear_layout(node: TNode) -> None:
    node.layout = None
    for child in node.children:
        clear_layout(child)


def _get_text_content(node: TNode) -> str:
    if node.text is not None:
        return node.text
    result = ""
    for child in node.children:
        if child.text is not None:
            result += child.text
    return result


def layout(root: TNode, term_width: int, _term_height: int) -> None:
    """
    Compute layout for the entire tree.
    Mutates each node's `layout` field in place.
    """
    clear_layout(root)
    root.layout = LayoutResult(x=0, y=0, width=term_width, height=0)
    _layout_children_list(root.children, root, 0, 0, term_width)
    root.layout.height = _compute_children_height_from_list(root.children, 0)


def content_height(root: TNode) -> int:
    """Returns the total vertical space the content occupies after layout."""
    return root.layout.height if root.layout else 0


def _layout_children(node: TNode, start_x: int, start_y: int, available_width: int) -> None:
    flex_direction = node.props.get("flexDirection", "column")
    if flex_direction == "row":
        _layout_row(node, start_x, start_y, available_width)
    else:
        _layout_column(node, start_x, start_y, available_width)


def _layout_children_list(
    children: list[TNode],
    parent: TNode,
    start_x: int,
    start_y: int,
    available_width: int,
) -> None:
    gap = parent.props.get("gap", 0)
    align = parent.props.get("alignItems")
    y = start_y

    for i, child in enumerate(children):
        margin = _resolve_margins(child)
        y += margin["top"]
        child_x = start_x + margin["left"]
        child_width = max(available_width - margin["left"] - margin["right"], 0)
        _layout_node(child, child_x, y, child_width)
        _apply_alignment(align, child, child_width)
        y += child.layout.height + margin["bottom"]  # type: ignore[union-attr]
        if i < len(children) - 1:
            y += gap

    if parent.props.get("height") is not None:
        border = 1 if parent.props.get("borderStyle") else 0
        pad = parent.props.get("padding", 0)
        padding_top = parent.props.get("paddingTop", pad) + border
        padding_bottom = parent.props.get("paddingBottom", pad) + border
        children_h = _compute_children_height_from_list(children, start_y)
        _apply_justify_content(
            parent, start_y, children_h,
            parent.props["height"] - padding_top - padding_bottom,
        )


def _compute_children_height_from_list(children: list[TNode], start_y: int) -> int:
    if not children:
        return 0
    max_bottom = start_y
    for child in children:
        if child.layout:
            margin = _resolve_margins(child)
            max_bottom = max(max_bottom, child.layout.y + child.layout.height + margin["bottom"])
    return max_bottom - start_y


def _layout_column(node: TNode, start_x: int, start_y: int, available_width: int) -> None:
    gap = node.props.get("gap", 0)
    align = node.props.get("alignItems")
    y = start_y

    for i, child in enumerate(node.children):
        margin = _resolve_margins(child)
        y += margin["top"]
        child_x = start_x + margin["left"]
        child_width = max(available_width - margin["left"] - margin["right"], 0)
        _layout_node(child, child_x, y, child_width)
        _apply_alignment(align, child, child_width)
        y += child.layout.height + margin["bottom"]  # type: ignore[union-attr]
        if i < len(node.children) - 1:
            y += gap

    if node.props.get("height") is not None:
        border = 1 if node.props.get("borderStyle") else 0
        pad = node.props.get("padding", 0)
        padding_top = node.props.get("paddingTop", pad) + border
        padding_bottom = node.props.get("paddingBottom", pad) + border
        children_h = _compute_children_height(node, start_y)
        _apply_justify_content(
            node, start_y, children_h,
            node.props["height"] - padding_top - padding_bottom,
        )


def _layout_row(node: TNode, start_x: int, start_y: int, available_width: int) -> None:
    children = node.children

    fixed_total = 0
    fill_count = 0

    for child in children:
        margin = _resolve_margins(child)
        h_margin = margin["left"] + margin["right"]
        if child.props.get("width") is not None:
            fixed_total += min(child.props["width"], available_width) + h_margin
        elif child.props.get("flexGrow"):
            fixed_total += h_margin
            fill_count += 1
        else:
            fixed_total += h_margin

    remaining_width = max(available_width - fixed_total, 0)
    fill_width = remaining_width // fill_count if fill_count > 0 else 0
    fill_remainder = remaining_width % fill_count if fill_count > 0 else 0

    x = start_x
    fill_index = 0

    for child in children:
        margin = _resolve_margins(child)
        x += margin["left"]

        if child.props.get("width") is not None:
            child_width = min(child.props["width"], available_width)
        elif child.props.get("flexGrow"):
            child_width = fill_width
            if fill_index == 0:
                child_width += fill_remainder
            fill_index += 1
        else:
            child_width = 0

        child_width = max(child_width, 0)
        _layout_node(child, x, start_y, child_width)
        x += child_width + margin["right"]

    used_width = x - start_x
    _apply_justify_content_row(node, start_x, used_width, available_width)


def _layout_node(node: TNode, x: int, y: int, available_width: int) -> None:
    if node.props.get("display") == "none":
        node.layout = LayoutResult(x=0, y=0, width=0, height=0)
        return

    if node.type == "divider":
        node.layout = LayoutResult(x=x, y=y, width=available_width, height=1)
        return

    if node.type == "text":
        _layout_text_node(node, x, y, available_width)
        return

    # Box node
    border = 1 if node.props.get("borderStyle") else 0
    pad = node.props.get("padding", 0)
    padding_left   = node.props.get("paddingLeft",   pad) + border
    padding_right  = node.props.get("paddingRight",  pad) + border
    padding_top    = node.props.get("paddingTop",    pad) + border
    padding_bottom = node.props.get("paddingBottom", pad) + border

    node_width = min(node.props.get("width", available_width), available_width)
    content_width = max(node_width - padding_left - padding_right, 0)
    content_x = x + padding_left
    content_y = y + padding_top

    node.layout = LayoutResult(x=x, y=y, width=node_width, height=0)

    _layout_children(node, content_x, content_y, content_width)

    node.layout.height = _compute_children_height(node, content_y) + padding_top + padding_bottom

    if node.props.get("height") is not None:
        node.layout.height = max(node.props["height"], 0)


def _layout_text_node(node: TNode, x: int, y: int, available_width: int) -> None:
    if node.props.get("display") == "none":
        node.layout = LayoutResult(x=0, y=0, width=0, height=0)
        return

    hanging_indent = node.props.get("hangingIndent", 0) or 0
    segments = node.props.get("segments")

    if segments is not None:
        wrapped_lines = wrap_segments(segments, available_width, hanging_indent)
        wrap_mode = node.props.get("wrap", "wrap")
        if wrap_mode != "wrap" and len(wrapped_lines) > 1:
            full_text = " ".join("".join(run.text for run in line) for line in wrapped_lines)
            truncated = _truncate_text(full_text, available_width, wrap_mode)
            wrapped_lines = [[StyledRun(text=truncated)]]
        node.layout = LayoutResult(
            x=x, y=y, width=available_width,
            height=len(wrapped_lines),
            wrapped_lines=wrapped_lines,
            hanging_indent=hanging_indent or None,
        )
        return

    content = _get_text_content(node)

    if not content or available_width <= 0:
        node.layout = LayoutResult(
            x=x, y=y, width=available_width, height=0,
            wrapped_lines=[],
            hanging_indent=hanging_indent or None,
        )
        return

    lines = wrap_text(content, available_width, hanging_indent)
    wrapped_lines = [[StyledRun(text=line)] for line in lines]
    wrap_mode = node.props.get("wrap", "wrap")
    if wrap_mode != "wrap" and len(wrapped_lines) > 1:
        full_text = " ".join("".join(run.text for run in line) for line in wrapped_lines)
        truncated = _truncate_text(full_text, available_width, wrap_mode)
        wrapped_lines = [[StyledRun(text=truncated)]]

    node.layout = LayoutResult(
        x=x, y=y, width=available_width,
        height=len(wrapped_lines),
        wrapped_lines=wrapped_lines,
        hanging_indent=hanging_indent or None,
    )


def _compute_children_height(node: TNode, start_y: int) -> int:
    if not node.children:
        return 0

    flex_direction = node.props.get("flexDirection", "column")

    if flex_direction == "row":
        return max((c.layout.height for c in node.children if c.layout), default=0)

    max_bottom = start_y
    for child in node.children:
        if child.layout:
            margin = _resolve_margins(child)
            max_bottom = max(max_bottom, child.layout.y + child.layout.height + margin["bottom"])
    return max_bottom - start_y
