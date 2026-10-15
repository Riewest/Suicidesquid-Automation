import { registerHook } from "../lib/hooks.js";
import { isActiveGM, messageHasSpellSlug, findOutcome } from "../lib/utils.js";
import { debug } from "../lib/debug.js";

const EFFECT_UUID = "Compendium.suicidesquid-automation.effects.Item.gVYWRgAw0eJSFKqe";
const SPELL_SLUG = "daze";
const BASE_RANK = 1;
const OUTCOME_BASE_WEAKNESS = { failure: 1, criticalFailure: 3 };

// Amp detection is unconfirmed; check the likely flag locations. Verify with DEBUG output.
function isAmped(message) {
  const pf2e = message.flags?.pf2e ?? {};
  const options = [...(pf2e.context?.options ?? []), ...(pf2e.origin?.rollOptions ?? [])];
  return options.some((o) => /(^|:)amp(ed)?$/.test(o)) || pf2e.origin?.variant?.overlays != null;
}

function getRank(message) {
  const pf2e = message.flags?.pf2e ?? {};
  return pf2e.origin?.castRank ?? pf2e.context?.origin?.castRank ?? BASE_RANK;
}

async function onUpdateChatMessage(message, change) {
  if (!isActiveGM()) return;
  if (!messageHasSpellSlug(message, SPELL_SLUG)) return;

  const changeString = JSON.stringify(change ?? {});
  if (!changeString.includes("pf2e-toolbelt")) return;

  debug("amped-daze", "toolbelt update", { amped: isAmped(message), flags: message.flags, change });
  const amped = isAmped(message);

  const itemSource = amped ? await fromUuid(EFFECT_UUID) : null;
  if (amped && !itemSource) return;

  const rankBonus = Math.floor((getRank(message) - BASE_RANK) / 2);

  for (const token of game.scenes.current?.tokens ?? []) {
    const actor = token.actor;
    if (!actor) continue;

    const matches =
      changeString.includes(token.id) ||
      changeString.includes(actor.id) ||
      changeString.includes(token.uuid);
    if (!matches) continue;

    const outcome = findOutcome(message.flags["pf2e-toolbelt"], [token.id, actor.id, token.uuid]);
    debug("amped-daze", `${actor.name} outcome:`, outcome);
    const base = OUTCOME_BASE_WEAKNESS[outcome];
    if (base === undefined) continue;

    if (amped) {
      const source = itemSource.toObject();
      foundry.utils.setProperty(source, "flags.pf2e.vulnerabilityValue", base + rankBonus);

      // Replace so a stronger or newer application takes effect.
      const existing = actor.itemTypes.effect.filter((e) => e.slug === source.system.slug);
      if (existing.length) await actor.deleteEmbeddedDocuments("Item", existing.map((e) => e.id));

      await actor.createEmbeddedDocuments("Item", [source]);
      ui.notifications.info(`Applied Amped Daze vulnerability (${base + rankBonus}) to ${actor.name}.`);
    }

    if (outcome === "criticalFailure") await actor.increaseCondition("stunned", { max: 1 });
  }
}

export default {
  id: "amped-daze",
  ready() {
    registerHook("amped-daze:update", "updateChatMessage", onUpdateChatMessage);
  },
};
