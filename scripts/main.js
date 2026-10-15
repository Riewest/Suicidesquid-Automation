import automations from "./automations/index.js";
import { debug } from "./lib/debug.js";

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

Hooks.once("init", () => run("init"));
Hooks.once("ready", () => run("ready"));
