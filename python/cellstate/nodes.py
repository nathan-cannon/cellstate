"""TNode tree data structures."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SegmentStyle:
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strikethrough: Optional[bool] = None
    dim: Optional[bool] = None
    inverse: Optional[bool] = None
    fg: Optional[str] = None
    color: Optional[str] = None          # alias for fg; takes priority when both set
    background_color: Optional[str] = None


@dataclass
class Segment:
    text: str
    style: Optional[SegmentStyle] = None


# A styled run after text wrapping — same shape as Segment, named for clarity.
@dataclass
class StyledRun:
    text: str
    style: Optional[SegmentStyle] = None


# A wrapped line is a list of styled runs.
WrappedLine = list[StyledRun]


@dataclass
class LayoutResult:
    x: int
    y: int
    width: int
    height: int
    wrapped_lines: Optional[list[WrappedLine]] = None
    hanging_indent: Optional[int] = None
    text_align: Optional[str] = None  # 'left' | 'center' | 'right'


@dataclass
class TNode:
    type: str                          # 'root' | 'box' | 'text' | 'divider'
    props: dict[str, Any] = field(default_factory=dict)
    children: list[TNode] = field(default_factory=list)
    parent: Optional[TNode] = field(default=None, repr=False)
    text: Optional[str] = None
    layout: Optional[LayoutResult] = None


def create_node(node_type: str, props: Optional[dict[str, Any]] = None) -> TNode:
    return TNode(type=node_type, props=props or {})


def append_child(parent: TNode, child: TNode) -> None:
    if child.parent is not None:
        remove_child(child.parent, child)
    child.parent = parent
    parent.children.append(child)


def remove_child(parent: TNode, child: TNode) -> None:
    try:
        parent.children.remove(child)
    except ValueError:
        pass
    child.parent = None


def insert_before(parent: TNode, child: TNode, before: TNode) -> None:
    if child.parent is not None:
        remove_child(child.parent, child)
    child.parent = parent
    try:
        idx = parent.children.index(before)
        parent.children.insert(idx, child)
    except ValueError:
        parent.children.append(child)
