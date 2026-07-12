import { coordinatorGetStatus } from "./jupyter-coordinator-client.js";

/**
 * 根据 DO 空闲 slot 放大本批 dispatch 上限，避免 batch_limit 过小导致 kernel 闲置。
 */
export async function resolveCoordinatorDispatchLimit(env, serverKey, baseLimit) {
  const floor = Math.max(1, Number(baseLimit) || 1);
  try {
    const status = await coordinatorGetStatus(env, serverKey);
    const maxSlots = Math.max(1, Number(status?.max_slots ?? 30));
    const running = Math.max(0, Number(status?.running_count ?? 0));
    const queued = Math.max(0, Number(status?.queue_length ?? 0));
    const available = Math.max(0, maxSlots - running - queued);
    return Math.max(floor, available);
  } catch {
    return floor;
  }
}
