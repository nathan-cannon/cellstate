/**
 * Yoga adapter — wraps yoga-layout v3 behind the FlexNode interface.
 * This is the only file in CellState that imports from yoga-layout.
 */
import Yoga from 'yoga-layout';
import {
  Align,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Wrap,
} from 'yoga-layout';
import type { Node as YogaNode } from 'yoga-layout';
import {
  type FlexNode,
  type FlexNodeFactory,
  type FlexEdge,
  type SizeFunc,
  SizeConstraint,
} from './flex-node.js';

// --- Enum maps ---

const FLEX_DIRECTION_MAP: Record<string, FlexDirection> = {
  column: FlexDirection.Column,
  row: FlexDirection.Row,
  'column-reverse': FlexDirection.ColumnReverse,
  'row-reverse': FlexDirection.RowReverse,
};

const ALIGN_MAP: Record<string, Align> = {
  auto: Align.Auto,
  stretch: Align.Stretch,
  'flex-start': Align.FlexStart,
  center: Align.Center,
  'flex-end': Align.FlexEnd,
  'space-between': Align.SpaceBetween,
  'space-around': Align.SpaceAround,
  'space-evenly': Align.SpaceEvenly,
};

const JUSTIFY_MAP: Record<string, Justify> = {
  'flex-start': Justify.FlexStart,
  center: Justify.Center,
  'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween,
  'space-around': Justify.SpaceAround,
  'space-evenly': Justify.SpaceEvenly,
};

const EDGE_MAP: Record<FlexEdge, Edge> = {
  left: Edge.Left,
  right: Edge.Right,
  top: Edge.Top,
  bottom: Edge.Bottom,
  horizontal: Edge.Horizontal,
  vertical: Edge.Vertical,
  all: Edge.All,
};

const DISPLAY_MAP: Record<string, Display> = {
  flex: Display.Flex,
  none: Display.None,
};

const DISPLAY_REVERSE: Record<number, 'flex' | 'none'> = {
  [Display.Flex]: 'flex',
  [Display.None]: 'none',
};

const POSITION_TYPE_MAP: Record<string, PositionType> = {
  relative: PositionType.Relative,
  absolute: PositionType.Absolute,
};

const OVERFLOW_MAP: Record<string, Overflow> = {
  visible: Overflow.Visible,
  hidden: Overflow.Hidden,
  scroll: Overflow.Scroll,
};

const WRAP_MAP: Record<string, Wrap> = {
  nowrap: Wrap.NoWrap,
  wrap: Wrap.Wrap,
  'wrap-reverse': Wrap.WrapReverse,
};

const MEASURE_MODE_MAP: Record<number, SizeConstraint> = {
  [MeasureMode.Exactly]: SizeConstraint.Exact,
  [MeasureMode.AtMost]: SizeConstraint.AtMost,
  [MeasureMode.Undefined]: SizeConstraint.None,
};

// --- Adapter ---

class YogaFlexNode implements FlexNode {
  /** @internal */
  readonly _node: YogaNode;

  constructor(node: YogaNode) {
    this._node = node;
  }

  // Tree operations
  insertChild(child: FlexNode, index: number): void {
    this._node.insertChild((child as YogaFlexNode)._node, index);
  }

  removeChild(child: FlexNode): void {
    this._node.removeChild((child as YogaFlexNode)._node);
  }

  getChildCount(): number {
    return this._node.getChildCount();
  }

  // Layout computation
  calculateLayout(availableWidth?: number): void {
    this._node.calculateLayout(
      availableWidth ?? undefined,
      undefined,
      Direction.LTR,
    );
  }

  setMeasureFunc(fn: SizeFunc): void {
    this._node.setMeasureFunc(
      (width: number, widthMode: MeasureMode, _height: number, _heightMode: MeasureMode) => {
        const constraint = MEASURE_MODE_MAP[widthMode] ?? SizeConstraint.None;
        return fn(width, constraint);
      },
    );
  }

  unsetMeasureFunc(): void {
    this._node.unsetMeasureFunc();
  }

  markDirty(): void {
    this._node.markDirty();
  }

  // Computed layout getters
  getComputedLeft(): number {
    return this._node.getComputedLeft();
  }

  getComputedTop(): number {
    return this._node.getComputedTop();
  }

  getComputedWidth(): number {
    return this._node.getComputedWidth();
  }

  getComputedHeight(): number {
    return this._node.getComputedHeight();
  }

  getComputedBorderLeft(): number {
    return this._node.getComputedBorder(Edge.Left);
  }

  getComputedBorderRight(): number {
    return this._node.getComputedBorder(Edge.Right);
  }

  getComputedBorderTop(): number {
    return this._node.getComputedBorder(Edge.Top);
  }

  getComputedBorderBottom(): number {
    return this._node.getComputedBorder(Edge.Bottom);
  }

  getComputedPaddingLeft(): number {
    return this._node.getComputedPadding(Edge.Left);
  }

  getComputedPaddingRight(): number {
    return this._node.getComputedPadding(Edge.Right);
  }

  getComputedPaddingTop(): number {
    return this._node.getComputedPadding(Edge.Top);
  }

  getComputedPaddingBottom(): number {
    return this._node.getComputedPadding(Edge.Bottom);
  }

  // Dimension setters
  setWidth(value: number): void {
    this._node.setWidth(value);
  }

  setWidthPercent(value: number): void {
    this._node.setWidthPercent(value);
  }

  setWidthAuto(): void {
    this._node.setWidthAuto();
  }

  setHeight(value: number): void {
    this._node.setHeight(value);
  }

  setHeightPercent(value: number): void {
    this._node.setHeightPercent(value);
  }

  setHeightAuto(): void {
    this._node.setHeightAuto();
  }

  setMinWidth(value: number): void {
    this._node.setMinWidth(value);
  }

  setMinHeight(value: number): void {
    this._node.setMinHeight(value);
  }

  setMaxWidth(value: number): void {
    this._node.setMaxWidth(value);
  }

  setMaxHeight(value: number): void {
    this._node.setMaxHeight(value);
  }

  // Flex properties
  setFlexDirection(dir: 'column' | 'row' | 'column-reverse' | 'row-reverse'): void {
    this._node.setFlexDirection(FLEX_DIRECTION_MAP[dir]!);
  }

  setFlexGrow(value: number): void {
    this._node.setFlexGrow(value);
  }

  setFlexShrink(value: number): void {
    this._node.setFlexShrink(value);
  }

  setFlexBasis(value: number): void {
    this._node.setFlexBasis(value);
  }

  setFlexBasisPercent(value: number): void {
    this._node.setFlexBasisPercent(value);
  }

  setFlexWrap(wrap: 'nowrap' | 'wrap' | 'wrap-reverse'): void {
    this._node.setFlexWrap(WRAP_MAP[wrap]!);
  }

  // Alignment
  setAlignItems(align: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end'): void {
    this._node.setAlignItems(ALIGN_MAP[align]!);
  }

  setAlignSelf(align: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end'): void {
    this._node.setAlignSelf(ALIGN_MAP[align]!);
  }

  setAlignContent(
    align:
      | 'auto'
      | 'stretch'
      | 'flex-start'
      | 'center'
      | 'flex-end'
      | 'space-between'
      | 'space-around'
      | 'space-evenly',
  ): void {
    this._node.setAlignContent(ALIGN_MAP[align]!);
  }

  setJustifyContent(
    justify:
      | 'flex-start'
      | 'center'
      | 'flex-end'
      | 'space-between'
      | 'space-around'
      | 'space-evenly',
  ): void {
    this._node.setJustifyContent(JUSTIFY_MAP[justify]!);
  }

  // Spacing
  setMargin(edge: FlexEdge, value: number): void {
    this._node.setMargin(EDGE_MAP[edge], value);
  }

  setPadding(edge: FlexEdge, value: number): void {
    this._node.setPadding(EDGE_MAP[edge], value);
  }

  setBorder(edge: FlexEdge, value: number): void {
    this._node.setBorder(EDGE_MAP[edge], value);
  }

  setGap(value: number): void {
    this._node.setGap(Gutter.All, value);
  }

  setColumnGap(value: number): void {
    this._node.setGap(Gutter.Column, value);
  }

  setRowGap(value: number): void {
    this._node.setGap(Gutter.Row, value);
  }

  // Other
  setDisplay(display: 'flex' | 'none'): void {
    this._node.setDisplay(DISPLAY_MAP[display]!);
  }

  getDisplay(): 'flex' | 'none' {
    return DISPLAY_REVERSE[this._node.getDisplay()] ?? 'flex';
  }

  setPositionType(type: 'relative' | 'absolute'): void {
    this._node.setPositionType(POSITION_TYPE_MAP[type]!);
  }

  setPosition(edge: FlexEdge, value: number): void {
    this._node.setPosition(EDGE_MAP[edge], value);
  }

  setOverflow(overflow: 'visible' | 'hidden' | 'scroll'): void {
    this._node.setOverflow(OVERFLOW_MAP[overflow]!);
  }

  setAspectRatio(ratio: number): void {
    this._node.setAspectRatio(ratio);
  }

  // Lifecycle
  free(): void {
    this._node.free();
  }

  freeRecursive(): void {
    this._node.freeRecursive();
  }
}

/**
 * Create a FlexNodeFactory backed by yoga-layout.
 * Each call to the returned factory creates a new Yoga node wrapped
 * behind the FlexNode interface.
 */
export function createFlexNodeFactory(): FlexNodeFactory {
  return () => new YogaFlexNode(Yoga.Node.create());
}
