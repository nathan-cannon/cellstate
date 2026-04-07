/**
 * React reconciler adapter. Translates React's host config calls (createInstance,
 * appendChild, commitUpdate, etc.) into TNode mutations. After each commit,
 * resetAfterCommit fires the onFrame callback to trigger a render frame.
 */
import createReconciler from 'react-reconciler';
import {
  ConcurrentRoot,
  DefaultEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js';
import { createContext } from 'react';
import type { ReactContext } from 'react-reconciler';
import {
  type TNode,
  createNode,
  appendChild as rawAppendChild,
  removeChild as rawRemoveChild,
  insertBefore as rawInsertBefore,
} from './nodes.js';
import type { FlexNodeFactory } from '../layout/flex-node.js';
import { applyBoxProps } from '../layout/apply-props.js';
import { computeTextLayout } from '../layout/text-layout.js';
import { propagateDirty, setAbsoluteFlag } from './dirty.js';

/** Props that affect rendering output (style, visibility, border, text content). */
const RENDERING_PROPS: readonly string[] = [
  'bold', 'dim', 'italic', 'underline', 'strikethrough', 'inverse',
  'fg', 'color', 'backgroundColor',
  'borderStyle', 'borderColor', 'display',
  'segments', 'wrap', 'hangingIndent', 'char',
  'lines', 'rawWidth',
];

function segmentsMatch(
  a: readonly { text: string; style?: unknown }[] | undefined,
  b: readonly { text: string; style?: unknown }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text || a[i]!.style !== b[i]!.style) return false;
  }
  return true;
}

/** All props that applyBoxProps reads — used to skip FFI calls when nothing changed. */
const LAYOUT_PROPS: readonly string[] = [
  'width', 'widthPercent', 'height', 'heightPercent',
  'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'flexDirection', 'flexGrow', 'flexShrink', 'flexBasis', 'flexWrap',
  'alignItems', 'alignSelf', 'alignContent', 'justifyContent',
  'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight',
  'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight',
  'gap', 'columnGap', 'rowGap',
  'position', 'top', 'left', 'right', 'bottom',
  'display', 'overflow', 'aspectRatio',
  'borderStyle',
];

function hasLayoutChange(
  oldProps: Record<string, any>,
  newProps: Record<string, any>,
): boolean {
  for (const key of LAYOUT_PROPS) {
    if (oldProps[key] !== newProps[key]) return true;
  }
  return false;
}

function linesMatch(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasRenderingChange(
  oldProps: Record<string, any>,
  newProps: Record<string, any>,
): boolean {
  for (const key of RENDERING_PROPS) {
    if (key === 'segments') {
      if (!segmentsMatch(oldProps.segments, newProps.segments)) return true;
      continue;
    }
    if (key === 'lines') {
      if (!linesMatch(oldProps.lines, newProps.lines)) return true;
      continue;
    }
    if (oldProps[key] !== newProps[key]) return true;
  }
  return false;
}

function appendChild(parent: TNode, child: TNode): void {
  rawAppendChild(parent, child);
  propagateDirty(parent);
}

function removeChild(parent: TNode, child: TNode): void {
  const wasAbsolute = child.props.position === 'absolute';
  rawRemoveChild(parent, child);
  parent._childWasDetached = true;
  propagateDirty(parent);
  if (wasAbsolute) setAbsoluteFlag();
}

function insertBefore(parent: TNode, child: TNode, before: TNode): void {
  rawInsertBefore(parent, child, before);
  propagateDirty(parent);
}

let currentUpdatePriority = NoEventPriority;

let nodeFactory: FlexNodeFactory | null = null;

export function setFlexNodeFactory(factory: FlexNodeFactory): void {
  nodeFactory = factory;
}

// WeakMap so root nodes can be GC'd when the frame loop stops.
const onFrameCallbacks = new WeakMap<TNode, (root: TNode) => void>();

type HostContext = Record<string, never>;

const reconciler = createReconciler({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,

  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,

  getRootHostContext: (): HostContext => ({} as HostContext),
  getChildHostContext: (): HostContext => ({} as HostContext),
  shouldSetTextContent: () => false,
  getPublicInstance: (node: TNode) => node,

  createInstance(type: string, props: Record<string, any>): TNode {
    const { children: _, ...rest } = props;
    const flexNode = nodeFactory ? nodeFactory() : undefined;
    const node = createNode(type as TNode['type'], rest, flexNode);

    if (flexNode) {
      if (type === 'text') {
        flexNode.setMeasureFunc((width, widthMode) =>
          computeTextLayout(node, width, widthMode),
        );
      } else if (type === 'raw-ansi') {
        flexNode.setMeasureFunc(() => ({
          width: (rest.rawWidth as number) ?? 0,
          height: (rest.lines as string[] | undefined)?.length ?? 0,
        }));
      } else {
        applyBoxProps(flexNode, rest, type === 'root');
        if (type === 'divider') {
          flexNode.setHeight(1);
        }
      }
    }

    return node;
  },

  createTextInstance(text: string): TNode {
    // Text instances are raw string children of <text> elements.
    // They don't get their own FlexNode — the parent <text> element's
    // measure function reads their content via node.text.
    const node = createNode('text', {});
    node.text = text;
    return node;
  },

  appendInitialChild: appendChild,
  appendChild,
  removeChild,
  insertBefore,

  appendChildToContainer: appendChild,
  insertInContainerBefore: insertBefore,
  removeChildFromContainer: removeChild,

  prepareForCommit: () => null,
  preparePortalMount: () => null,
  clearContainer: () => false,

  resetAfterCommit(rootNode: TNode) {
    const cb = onFrameCallbacks.get(rootNode);
    if (cb) cb(rootNode);
  },

  resetTextContent(node: TNode) {
    node.children = node.children.filter((c) => c.text === null);
  },

  // Strip React's `children` prop since child relationships are managed
  // via appendChild/removeChild, not through props.
  commitUpdate(node: TNode, _type: string, _oldProps: any, newProps: any) {
    const { children: _, ...rest } = newProps;
    const oldProps = node.props;
    const renderingChanged = hasRenderingChange(oldProps, rest);
    node.props = rest;

    if (node.flexNode) {
      if (node.type === 'text') {
        // Check if text-relevant props changed (deep-compare segments)
        if (
          !segmentsMatch(oldProps.segments, rest.segments) ||
          oldProps.wrap !== rest.wrap ||
          oldProps.hangingIndent !== rest.hangingIndent
        ) {
          node._wrapCache = null;
          node.flexNode.markDirty();
        }
      } else if (node.type === 'raw-ansi') {
        if (oldProps.lines !== rest.lines || oldProps.rawWidth !== rest.rawWidth) {
          node.flexNode.setMeasureFunc(() => ({
            width: (rest.rawWidth as number) ?? 0,
            height: (rest.lines as string[] | undefined)?.length ?? 0,
          }));
          node.flexNode.markDirty();
        }
      } else {
        if (hasLayoutChange(oldProps, rest)) {
          applyBoxProps(node.flexNode, rest, node.type === 'root');
        }
        if (node.type === 'divider') {
          node.flexNode.setHeight(1);
        }
      }
    }

    if (renderingChanged) {
      propagateDirty(node);
    }
  },

  commitTextUpdate(node: TNode, _oldText: string, newText: string) {
    if (node.text === newText) return;
    node.text = newText;
    node._wrapCache = null;
    // Text instances live as children of <text> elements.
    // Mark the parent's flexNode dirty since that's where the measure func lives.
    if (node.parent?.flexNode) {
      node.parent.flexNode.markDirty();
    }
    propagateDirty(node);
  },

  finalizeInitialChildren: () => false,

  // Priority system
  setCurrentUpdatePriority(newPriority: number) {
    currentUpdatePriority = newPriority;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority() {
    if (currentUpdatePriority !== NoEventPriority) {
      return currentUpdatePriority;
    }
    return DefaultEventPriority;
  },

  // Suspend/transition stubs
  maySuspendCommit: () => false,
  NotPendingTransition: null,
  HostTransitionContext: createContext(null) as unknown as ReactContext<unknown>,
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,

  // Instance visibility
  hideInstance: () => {},
  unhideInstance: () => {},
  hideTextInstance: () => {},
  unhideTextInstance: () => {},

  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  detachDeletedInstance: () => {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
} as any);

export function mountRoot(
  element: React.ReactElement,
  onFrame: (root: TNode) => void,
): { update: (element: React.ReactElement) => void } {
  const flexNode = nodeFactory ? nodeFactory() : undefined;
  const rootNode = createNode('root', {}, flexNode);
  onFrameCallbacks.set(rootNode, onFrame);

  const container = reconciler.createContainer(
    rootNode,       // containerInfo
    ConcurrentRoot, // tag
    null,           // hydrationCallbacks
    false,          // isStrictMode
    null,           // concurrentUpdatesByDefaultOverride
    '',             // identifierPrefix
    console.error,  // onUncaughtError
    console.error,  // onCaughtError
    console.error,  // onRecoverableError
    () => {},        // onDefaultTransitionIndicator
  );

  reconciler.updateContainer(element, container, null, null);

  return {
    update: (el: React.ReactElement) =>
      reconciler.updateContainer(el, container, null, null),
  };
}
