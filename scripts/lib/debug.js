// Flip to true to enable debug output in the browser console.
export const DEBUG = true;

const PREFIX = "suicidesquid-automation |";

export function debug(scope, ...args) {
  if (DEBUG) console.debug(PREFIX, `[${scope}]`, ...args);
}
