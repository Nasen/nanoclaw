import fs from 'fs';
import path from 'path';

import { AvailableGroup } from './container-contract.js';
import { resolveGroupIpcPath } from './group-folder.js';

export interface TaskSnapshot {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: TaskSnapshot[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((task) => task.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
