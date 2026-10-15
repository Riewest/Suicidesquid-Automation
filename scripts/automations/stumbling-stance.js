import { registerHook } from "../lib/hooks.js";
import { isActiveGM } from "../lib/utils.js";
import { debug } from "../lib/debug.js";

const MODULE_ID = "suicidesquid-automation";
const EFFECT_UUID = "Compendium.suicidesquid-automation.effects.Item.ldqWeBKZ6XHhCPtc";
const STANCE_SLUG_PART = "stumbling-stance";
const SWING_SLUG = "stumbling-swing";
const HIT_OUTCOMES = ["success", "criticalSuccess"];

function getAttackInfo(message) {
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll") return null;

  const targetToken = context.target?.token ? fromUuidSync(context.target.token) : null;
  return {
    context,
    attacker: message.actor,
    target: targetToken?.actor ?? null,
    targetToken,
  };
}

function isMelee(context) {
  return context.options?.some((o) => o === "item:melee" || o === "melee");
}

function hasStance(actor) {
  // Our own off-guard effect's slug also contains the stance name, so exclude it.
  return actor?.itemTypes.effect.some((e) => e.slug?.includes(STANCE_SLUG_PART) && !e.flags?.[MODULE_ID]?.stumblingStance);
}

function findOwnEffects(actor, monkUuid) {
  return actor.itemTypes.effect.filter((e) => e.flags?.[MODULE_ID]?.stumblingStance?.monk === monkUuid);
}

// An enemy hitting a monk in the stance becomes off-guard to the monk's next Stumbling Swing.
async function applyRider(message, info) {
  const { context, attacker, target, targetToken } = info;
  if (!attacker || !target || attacker === target) return;
  if (!hasStance(target) || !isMelee(context) || !HIT_OUTCOMES.includes(context.outcome)) return;
  if (!EFFECT_UUID) return ui.notifications.warn("Stumbling Stance: effect UUID is not configured.");

  const itemSource = await fromUuid(EFFECT_UUID);
  if (!itemSource) return;

  // Expiry is handled in onTurnChange; PF2e's duration math runs a round late for this wording.
  const monkIsActing = game.combat?.combatant?.actor === target;
  const source = itemSource.toObject();
  foundry.utils.mergeObject(source, {
    system: {
      context: { origin: { actor: target.uuid, token: targetToken?.uuid ?? null, item: null, spellcasting: null } },
      duration: { value: -1, unit: "unlimited", sustained: false, expiry: null },
    },
    flags: { [MODULE_ID]: { stumblingStance: { monk: target.uuid, skipNextTurnEnd: monkIsActing } } },
  });

  // Replace so a repeat hit refreshes the duration.
  const existing = findOwnEffects(attacker, target.uuid);
  if (existing.length) await attacker.deleteEmbeddedDocuments("Item", existing.map((e) => e.id));

  await attacker.createEmbeddedDocuments("Item", [source]);
  debug("stumbling-stance", `${attacker.name} is off-guard to ${target.name}`);
  ui.notifications.info(`${attacker.name} is off-guard against ${target.name}'s next Stumbling Swing.`);
}

// The monk's Stumbling Swing uses up the off-guard on its target.
async function consumeRider(message, info) {
  const { attacker, target } = info;
  const slug = message.item?.slug ?? message.flags?.pf2e?.origin?.slug;
  if (!attacker || !target || slug !== SWING_SLUG) return;

  const existing = findOwnEffects(target, attacker.uuid);
  if (!existing.length) return;
  await target.deleteEmbeddedDocuments("Item", existing.map((e) => e.id));
  debug("stumbling-stance", `consumed off-guard on ${target.name}`);
}

async function onCreateChatMessage(message) {
  if (!isActiveGM()) return;
  const info = getAttackInfo(message);
  if (!info) return;

  debug("stumbling-stance", "attack roll", {
    slug: message.item?.slug,
    options: info.context.options,
    outcome: info.context.outcome,
    attacker: info.attacker?.name,
    target: info.target?.name,
  });

  await applyRider(message, info);
  await consumeRider(message, info);
}

// Tracked here so we don't depend on how hook arguments describe the previous turn.
const activeCombatant = new Map();

// Ends the off-guard when the monk's next turn finishes.
async function onUpdateCombat(combat, change) {
  if (!("turn" in change || "round" in change)) return;

  const endedId = activeCombatant.get(combat.id);
  activeCombatant.set(combat.id, combat.combatant?.id ?? null);
  debug("stumbling-stance", "turn change", { ended: endedId, started: combat.combatant?.id });
  if (!isActiveGM() || !endedId || endedId === combat.combatant?.id) return;

  const monk = combat.combatants.get(endedId)?.actor;
  if (!monk) return;

  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (!actor) continue;
    for (const effect of findOwnEffects(actor, monk.uuid)) {
      if (effect.flags[MODULE_ID].stumblingStance.skipNextTurnEnd) {
        await effect.setFlag(MODULE_ID, "stumblingStance.skipNextTurnEnd", false);
      } else {
        await effect.delete();
        debug("stumbling-stance", `expired on ${actor.name}`);
      }
    }
  }
}

export default {
  id: "stumbling-stance",
  ready() {
    for (const combat of game.combats) activeCombatant.set(combat.id, combat.combatant?.id ?? null);
    registerHook("stumbling-stance:attack", "createChatMessage", onCreateChatMessage);
    registerHook("stumbling-stance:turn", "updateCombat", onUpdateCombat);
  },
};
