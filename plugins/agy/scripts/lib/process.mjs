/**
 * Process inspection and teardown helpers.
 *
 * Signalling a PID read from a state file is only safe if you first confirm the
 * PID is still the process you think it is — PIDs get reused, and a stale record
 * could otherwise send SIGKILL to an unrelated process group.
 */

import { execFileSync } from 'node:child_process';

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return error.code === 'EPERM';
  }
}

/** Full command line for a pid, or null if it is gone. */
export function commandOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Confirm a pid is alive AND its command line still contains `marker`.
 * Guards against PID reuse before we signal anything.
 */
export function identityMatches(pid, marker) {
  if (!isAlive(pid)) return false;
  const command = commandOf(pid);
  if (command === null) return false;
  return command.includes(marker);
}

export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function signalPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Non-blocking sleep used by the monitor's TERM → grace → KILL sequence. */
export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
