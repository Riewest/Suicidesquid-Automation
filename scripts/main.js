import automations from "./automations/index.js";
import { debug } from "./lib/debug.js";
import { unregisterHooks } from "./lib/hooks.js";

const MODULE_ID = "suicidesquid-automation";
const enabledAutomations = new Set();

function settingKey(automation) {
  return `enabled-${automation.id}`;
}

function setAutomationEnabled(automation, enabled) {
  if (enabled && !enabledAutomations.has(automation.id)) {
    enabledAutomations.add(automation.id);
    try {
      debug("main", `${automation.id}: enabled`);
      automation.ready?.();
    } catch (err) {
      enabledAutomations.delete(automation.id);
      console.error(`${MODULE_ID} | ${automation.id} failed to enable`, err);
    }
  } else if (!enabled && enabledAutomations.has(automation.id)) {
    enabledAutomations.delete(automation.id);
    unregisterHooks(automation.id);
    debug("main", `${automation.id}: disabled`);
  }
}

function registerAutomationSettings() {
  for (const automation of automations) {
    game.settings.register(MODULE_ID, settingKey(automation), {
      name: `Enable: ${automation.id}`,
      hint: `Turn the ${automation.id} automation on or off during this session.`,
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: (enabled) => setAutomationEnabled(automation, enabled),
    });
  }
}

function run(stage) {
  for (const automation of automations) {
    try {
      debug("main", `${automation.id}: ${stage}`);
      automation[stage]?.();
    } catch (err) {
      console.error(`suicidesquid-automation | ${automation.id} failed during ${stage}`, err);
    }
  }
}

Hooks.once("init", () => {
  registerAutomationSettings();
  run("init");
});
Hooks.once("ready", () => {
  for (const automation of automations) {
    setAutomationEnabled(automation, game.settings.get(MODULE_ID, settingKey(automation)));
  }
});
