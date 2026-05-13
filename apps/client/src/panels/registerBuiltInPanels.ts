/**
 * Registers all built-in panels at module import time. Add new panels here.
 *
 * Heavy panels (3D Properties / Hierarchy) are still lightweight to import
 * because they only attach a React component reference; the component itself
 * is lazy-rendered only when its tab is opened.
 */

import { registerPanel } from '../workspace/panelRegistry';
import { ChatPanel } from './ChatPanel';
import { NotesPanel } from './NotesPanel';
import { BoardsPanel } from './BoardsPanel';
import { MembersPanel } from './MembersPanel';
import { LayersPanel } from './LayersPanel';
import { HierarchyPanel } from './HierarchyPanel';
import { PropertiesPanel } from './PropertiesPanel';

let registered = false;

export function registerBuiltInPanels(): void {
  if (registered) return;
  registered = true;

  registerPanel({
    id: 'boards',
    title: 'Boards',
    defaultSide: 'left',
    render: BoardsPanel,
    order: 0,
    mode: 'both',
  });
  registerPanel({
    id: 'hierarchy',
    title: 'Hierarchy',
    defaultSide: 'left',
    render: HierarchyPanel,
    order: 10,
    mode: '3d',
  });
  registerPanel({
    id: 'layers',
    title: 'Layers',
    defaultSide: 'right',
    render: LayersPanel,
    order: 0,
    mode: '2d',
  });
  registerPanel({
    id: 'props',
    title: 'Properties',
    defaultSide: 'right',
    render: PropertiesPanel,
    order: 1,
    mode: '3d',
  });
  registerPanel({
    id: 'chat',
    title: 'Chat',
    defaultSide: 'right',
    render: ChatPanel,
    order: 10,
    mode: 'both',
  });
  registerPanel({
    id: 'notes',
    title: 'Notes',
    defaultSide: 'right',
    render: NotesPanel,
    order: 11,
    mode: 'both',
  });
  registerPanel({
    id: 'members',
    title: 'Members',
    defaultSide: 'right',
    render: MembersPanel,
    order: 12,
    mode: 'both',
  });
}
