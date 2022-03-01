import React, { useMemo } from 'react';
import { indentStyle } from '@teambit/base-ui.graph.tree.indent';
import { Tree, TreeNodeProps, TreeNode } from '@teambit/design.ui.tree';
import { PayloadType, ScopeTreeNode } from '@teambit/ui-foundation.ui.side-bar';
import { LanesModel, useLanesContext } from '@teambit/lanes.ui.lanes';
import { TreeContextProvider } from '@teambit/base-ui.graph.tree.tree-context';
import { LaneTreeNode } from './lane-tree-node';

export type LaneTreeProps = {
  isCollapsed?: boolean;
  showScope: boolean;
};

export function LaneTree({ isCollapsed, showScope }: LaneTreeProps) {
  const lanesContext = useLanesContext();
  const activeLaneName = lanesContext?.currentLane?.name;

  const tree: TreeNode<PayloadType> = useMemo(() => laneToTree(lanesContext, { showScope }), [lanesContext?.lanes]);

  return (
    <TreeContextProvider selected={lanesContext?.currentLane?.id}>
      <div style={indentStyle(1)}>
        <Tree TreeNode={LaneTreeNodeRenderer} activePath={activeLaneName} tree={tree} isCollapsed={isCollapsed} />
      </div>
    </TreeContextProvider>
  );
}

function LaneTreeNodeRenderer(props: TreeNodeProps<PayloadType>) {
  const payload = props.node.payload;
  if (!payload) return <ScopeTreeNode {...props} />;
  return <LaneTreeNode {...props} />;
}

function laneToTree(lanesModel: LanesModel | undefined, { showScope }: { showScope: boolean }) {
  const lanesByScope = lanesModel?.lanesByScope;
  const scopes = (lanesByScope && [...lanesByScope.keys()]) || [];
  return {
    id: '',
    children: showScope
      ? scopes.map((scope) => ({
          id: scope,
          children: (lanesByScope?.get(scope) || []).map((lane) => ({
            id: lane.id,
            payload: lane,
          })),
        }))
      : lanesModel?.lanes.map((lane) => ({
          id: lane.id,
          payload: lane,
        })),
  };
}