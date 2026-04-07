/**
 * Maps CellState BoxProps onto FlexNode setters.
 * Called from the reconciler on createInstance and commitUpdate.
 */
import type { FlexNode } from './flex-node.js';

export function applyBoxProps(
  flexNode: FlexNode,
  props: Record<string, any>,
  isRoot: boolean = false,
): void {
  // --- Dimensions ---
  if (props.width != null) {
    flexNode.setWidth(props.width);
  } else if (props.widthPercent != null) {
    flexNode.setWidthPercent(props.widthPercent);
  } else if (!isRoot) {
    flexNode.setWidthAuto();
  }

  if (props.height != null) {
    flexNode.setHeight(props.height);
  } else if (props.heightPercent != null) {
    flexNode.setHeightPercent(props.heightPercent);
  }

  if (props.minWidth != null) flexNode.setMinWidth(props.minWidth);
  if (props.maxWidth != null) flexNode.setMaxWidth(props.maxWidth);
  if (props.minHeight != null) flexNode.setMinHeight(props.minHeight);
  if (props.maxHeight != null) flexNode.setMaxHeight(props.maxHeight);

  // --- Flex ---
  flexNode.setFlexDirection(props.flexDirection ?? 'column');

  if (props.flexGrow != null) {
    flexNode.setFlexGrow(props.flexGrow === true ? 1 : (props.flexGrow || 0));
  } else {
    flexNode.setFlexGrow(0);
  }

  if (props.flexShrink != null) flexNode.setFlexShrink(props.flexShrink);

  if (props.flexBasis != null) {
    if (typeof props.flexBasis === 'string') {
      flexNode.setFlexBasisPercent(parseInt(props.flexBasis, 10));
    } else {
      flexNode.setFlexBasis(props.flexBasis);
    }
  }

  if (props.flexWrap != null) flexNode.setFlexWrap(props.flexWrap);

  // --- Padding (all → axis shorthands → individual overrides) ---
  flexNode.setPadding('all', props.padding ?? 0);
  if (props.paddingX != null) flexNode.setPadding('horizontal', props.paddingX);
  if (props.paddingY != null) flexNode.setPadding('vertical', props.paddingY);
  if (props.paddingLeft != null) flexNode.setPadding('left', props.paddingLeft);
  if (props.paddingRight != null) flexNode.setPadding('right', props.paddingRight);
  if (props.paddingTop != null) flexNode.setPadding('top', props.paddingTop);
  if (props.paddingBottom != null) flexNode.setPadding('bottom', props.paddingBottom);

  // --- Margin (all → axis shorthands → individual overrides) ---
  flexNode.setMargin('all', props.margin ?? 0);
  if (props.marginX != null) flexNode.setMargin('horizontal', props.marginX);
  if (props.marginY != null) flexNode.setMargin('vertical', props.marginY);
  if (props.marginLeft != null) flexNode.setMargin('left', props.marginLeft);
  if (props.marginRight != null) flexNode.setMargin('right', props.marginRight);
  if (props.marginTop != null) flexNode.setMargin('top', props.marginTop);
  if (props.marginBottom != null) flexNode.setMargin('bottom', props.marginBottom);

  // --- Border ---
  flexNode.setBorder('all', props.borderStyle ? 1 : 0);

  // --- Alignment ---
  flexNode.setAlignItems(props.alignItems ?? 'stretch');
  if (props.alignSelf != null) flexNode.setAlignSelf(props.alignSelf);
  if (props.alignContent != null) flexNode.setAlignContent(props.alignContent);
  flexNode.setJustifyContent(props.justifyContent ?? 'flex-start');

  // --- Other ---
  flexNode.setDisplay(props.display ?? 'flex');

  flexNode.setGap(props.gap ?? 0);
  if (props.columnGap != null) flexNode.setColumnGap(props.columnGap);
  if (props.rowGap != null) flexNode.setRowGap(props.rowGap);

  // --- Positioning ---
  if (props.position === 'absolute') {
    flexNode.setPositionType('absolute');
  } else {
    flexNode.setPositionType('relative');
  }
  if (props.top != null) flexNode.setPosition('top', props.top);
  if (props.left != null) flexNode.setPosition('left', props.left);
  if (props.right != null) flexNode.setPosition('right', props.right);
  if (props.bottom != null) flexNode.setPosition('bottom', props.bottom);

  if (props.overflow != null) flexNode.setOverflow(props.overflow);
  if (props.aspectRatio != null) flexNode.setAspectRatio(props.aspectRatio);
}
