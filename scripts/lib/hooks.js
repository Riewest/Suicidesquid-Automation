import { debug } from "./debug.js";

const registered = (globalThis._suicidesquidHooks ??= new Map());

/** Registers a hook, replacing any previous registration with the same name (safe for reloads). */
export function registerHook(name, event, fn) {
  const previous = registered.get(name);
  if (previous) Hooks.off(previous.event, previous.id);
  registered.set(name, { event, id: Hooks.on(event, fn) });
  debug("hooks", `registered ${name} on ${event}`);
}

/** Removes all hooks registered under an automation's name prefix. */
export function unregisterHooks(prefix) {
  for (const [name, hook] of registered) {
    if (name === prefix || name.startsWith(`${prefix}:`)) {
      Hooks.off(hook.event, hook.id);
      registered.delete(name);
      debug("hooks", `unregistered ${name} from ${hook.event}`);
    }
  }
}
