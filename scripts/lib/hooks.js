import { debug } from "./debug.js";

const registered = (globalThis._suicidesquidHooks ??= new Map());

/** Registers a hook, replacing any previous registration with the same name (safe for reloads). */
export function registerHook(name, event, fn) {
  const previous = registered.get(name);
  if (previous) Hooks.off(previous.event, previous.id);
  registered.set(name, { event, id: Hooks.on(event, fn) });
  debug("hooks", `registered ${name} on ${event}`);
}
