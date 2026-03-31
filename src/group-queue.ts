import { ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 1;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  keepAliveContainer: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  lastActivityAt: number;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private serviceEnabled = true;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        keepAliveContainer: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        lastActivityAt: 0,
        retryCount: 0,
        retryTimer: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private touchGroup(state: GroupState): void {
    state.lastActivityAt = Date.now();
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  async setServiceEnabled(enabled: boolean): Promise<void> {
    if (this.serviceEnabled === enabled) return;

    this.serviceEnabled = enabled;
    if (enabled) {
      logger.info('GroupQueue resumed after service re-enable');
      return;
    }

    this.waitingGroups = [];
    const stopPromises: Promise<void>[] = [];

    for (const [groupJid, state] of this.groups) {
      state.pendingMessages = false;
      state.pendingTasks = [];
      state.retryCount = 0;
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      if (state.process && !state.process.killed) {
        stopPromises.push(this.stopActiveGroup(groupJid, state));
      }
    }

    await Promise.all(stopPromises);
    logger.info('GroupQueue paused for emergency service disable');
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown || !this.serviceEnabled) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.evictOldestIdleContainer(groupJid);
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown || !this.serviceEnabled) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.evictOldestIdleContainer(groupJid);
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    this.touchGroup(state);
    if (typeof proc.once === 'function') {
      proc.once('close', () => {
        this.handlePersistentProcessExit(groupJid, proc);
      });
    } else if (typeof proc.on === 'function') {
      proc.on('close', () => {
        this.handlePersistentProcessExit(groupJid, proc);
      });
    }
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    state.keepAliveContainer = true;
    this.touchGroup(state);
    if (!this.serviceEnabled) return;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!this.serviceEnabled) return false;
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    state.keepAliveContainer = true;
    this.touchGroup(state);

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  resetChatSession(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.pendingMessages = false;
    state.retryCount = 0;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.active && !state.isTaskContainer) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    if (!this.serviceEnabled) return;

    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.keepAliveContainer = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.touchGroup(state);
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (!this.serviceEnabled) {
          state.retryCount = 0;
        } else if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      if (state.keepAliveContainer && state.process && !state.isTaskContainer) {
        logger.debug({ groupJid }, 'Keeping chat container alive after turn');
        return;
      }
      this.clearActiveState(groupJid, state);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    if (!this.serviceEnabled) return;

    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.keepAliveContainer = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.touchGroup(state);
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      this.clearActiveState(groupJid, state);
    }
  }

  private clearActiveState(groupJid: string, state: GroupState): void {
    if (state.active) {
      this.activeCount--;
    }
    state.active = false;
    state.idleWaiting = false;
    state.keepAliveContainer = false;
    state.isTaskContainer = false;
    state.runningTaskId = null;
    state.process = null;
    state.containerName = null;
    state.groupFolder = null;
    this.drainGroup(groupJid);
  }

  private handlePersistentProcessExit(
    groupJid: string,
    proc: ChildProcess,
  ): void {
    const state = this.getGroup(groupJid);
    if (state.process !== proc || !state.keepAliveContainer) return;

    logger.debug(
      { groupJid, containerName: state.containerName },
      'Persistent container exited',
    );
    this.clearActiveState(groupJid, state);
  }

  private evictOldestIdleContainer(requestingGroupJid: string): boolean {
    let selected: [string, GroupState] | null = null;

    for (const entry of this.groups.entries()) {
      const [groupJid, state] = entry;
      if (groupJid === requestingGroupJid) continue;
      if (
        !state.active ||
        !state.idleWaiting ||
        state.isTaskContainer ||
        !state.process ||
        !state.containerName
      ) {
        continue;
      }
      if (!selected || state.lastActivityAt < selected[1].lastActivityAt) {
        selected = entry;
      }
    }

    if (!selected) return false;

    const [groupJid, state] = selected;
    logger.info(
      {
        evictedGroupJid: groupJid,
        requestingGroupJid,
        containerName: state.containerName,
      },
      'Evicting oldest idle container to free capacity',
    );
    this.closeStdin(groupJid);
    return true;
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    if (!this.serviceEnabled) return;

    const nextRetryCount = state.retryCount + 1;
    if (nextRetryCount > MAX_RETRIES) {
      logger.error(
        {
          groupJid,
          retryCount: MAX_RETRIES,
          failedAttempts: nextRetryCount,
        },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    state.retryCount = nextRetryCount;

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.shuttingDown && this.serviceEnabled) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown || !this.serviceEnabled) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      this.serviceEnabled
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }

  private stopActiveGroup(groupJid: string, state: GroupState): Promise<void> {
    const proc = state.process;
    const containerName = state.containerName;

    logger.warn(
      { groupJid, containerName, runningTaskId: state.runningTaskId },
      'Emergency service disable stopping active container',
    );

    return new Promise((resolve) => {
      const killProcess = () => {
        if (!proc || proc.killed) {
          resolve();
          return;
        }

        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      };

      if (!containerName) {
        killProcess();
        return;
      }

      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { groupJid, containerName, err },
            'Graceful emergency stop failed, force killing process',
          );
        }
        killProcess();
      });
    });
  }
}
