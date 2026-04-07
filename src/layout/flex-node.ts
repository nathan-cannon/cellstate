/**
 * Layout node abstraction — the contract between CellState and any flexbox
 * layout engine. Everything above this interface (reconciler, frame loop,
 * rasterizer) never touches Yoga or any other engine directly.
 */

export type FlexEdge = 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical' | 'all';

export enum SizeConstraint {
  Exact = 0,
  AtMost = 1,
  None = 2,
}

export type SizeFunc = (
  width: number,
  widthMode: SizeConstraint,
) => { width: number; height: number };

export interface FlexNode {
  // --- Tree operations ---
  insertChild(child: FlexNode, index: number): void;
  removeChild(child: FlexNode): void;
  getChildCount(): number;

  // --- Layout computation ---
  calculateLayout(availableWidth?: number): void;
  setMeasureFunc(fn: SizeFunc): void;
  unsetMeasureFunc(): void;
  markDirty(): void;

  // --- Computed layout getters ---
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
  getComputedBorderLeft(): number;
  getComputedBorderRight(): number;
  getComputedBorderTop(): number;
  getComputedBorderBottom(): number;
  getComputedPaddingLeft(): number;
  getComputedPaddingRight(): number;
  getComputedPaddingTop(): number;
  getComputedPaddingBottom(): number;

  // --- Dimension setters ---
  setWidth(value: number): void;
  setWidthPercent(value: number): void;
  setWidthAuto(): void;
  setHeight(value: number): void;
  setHeightPercent(value: number): void;
  setHeightAuto(): void;
  setMinWidth(value: number): void;
  setMinHeight(value: number): void;
  setMaxWidth(value: number): void;
  setMaxHeight(value: number): void;

  // --- Flex properties ---
  setFlexDirection(dir: 'column' | 'row' | 'column-reverse' | 'row-reverse'): void;
  setFlexGrow(value: number): void;
  setFlexShrink(value: number): void;
  setFlexBasis(value: number): void;
  setFlexBasisPercent(value: number): void;
  setFlexWrap(wrap: 'nowrap' | 'wrap' | 'wrap-reverse'): void;

  // --- Alignment ---
  setAlignItems(align: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end'): void;
  setAlignSelf(align: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end'): void;
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
  ): void;
  setJustifyContent(
    justify:
      | 'flex-start'
      | 'center'
      | 'flex-end'
      | 'space-between'
      | 'space-around'
      | 'space-evenly',
  ): void;

  // --- Spacing ---
  setMargin(edge: FlexEdge, value: number): void;
  setPadding(edge: FlexEdge, value: number): void;
  setBorder(edge: FlexEdge, value: number): void;
  setGap(value: number): void;
  setColumnGap(value: number): void;
  setRowGap(value: number): void;

  // --- Other ---
  setDisplay(display: 'flex' | 'none'): void;
  getDisplay(): 'flex' | 'none';
  setPositionType(type: 'relative' | 'absolute'): void;
  setPosition(edge: FlexEdge, value: number): void;
  setOverflow(overflow: 'visible' | 'hidden' | 'scroll'): void;
  setAspectRatio(ratio: number): void;

  // --- Lifecycle ---
  free(): void;
  freeRecursive(): void;
}

/** Factory that creates new FlexNode instances. */
export type FlexNodeFactory = () => FlexNode;
