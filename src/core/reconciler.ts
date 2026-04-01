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
  appendChild,
  removeChild,
  insertBefore,
} from './nodes.js';

let currentUpdatePriority = NoEventPriority;

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
    return createNode(type as TNode['type'], rest);
  },

  createTextInstance(text: string): TNode {
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
    node.props = rest;
  },

  commitTextUpdate(node: TNode, _oldText: string, newText: string) {
    node.text = newText;
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
  const rootNode = createNode('root', {});
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
