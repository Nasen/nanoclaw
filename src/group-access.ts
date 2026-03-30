import { GROUPS_DIR } from './config.js';
import { isMainFolder, isPersonalFolder } from './rc-auto-register.js';
import { RegisteredGroup } from './types.js';

export function isMainGroup(group: RegisteredGroup): boolean {
  return group.isMain === true || isMainFolder(group.folder, GROUPS_DIR);
}

export function isMainGroupFolder(folder: string): boolean {
  return isMainFolder(folder, GROUPS_DIR);
}

export function isPersonalModeGroup(group: RegisteredGroup): boolean {
  return isMainGroup(group) || isPersonalFolder(group.folder, GROUPS_DIR);
}
