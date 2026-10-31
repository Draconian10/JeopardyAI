// One-use handoff from the PIN-verified launch to its host console. Never stores the PIN.
const pending = new Map<string, string>();
export function handoffController(id: string, controller: string) {
  pending.set(id, controller);
  try {
    sessionStorage.setItem(`jeopardy:launch:${id}`, controller);
  } catch {
    /* Memory handles client navigation when storage is unavailable. */
  }
}
export function takeLaunchController(id: string): string | undefined {
  let controller = pending.get(id);
  pending.delete(id);
  try {
    controller ??= sessionStorage.getItem(`jeopardy:launch:${id}`) ?? undefined;
    sessionStorage.removeItem(`jeopardy:launch:${id}`);
  } catch {
    /* Fall back to the in-memory handoff. */
  }
  return controller &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(controller)
    ? controller
    : undefined;
}
