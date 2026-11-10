import { registerHook } from "../lib/hooks.js";
import { isActiveGM, findOutcome } from "../lib/utils.js";
import { debug } from "../lib/debug.js";
import { addDescription } from "../lib/addenda.js";

const EFFECT_UUID = "Compendium.suicidesquid-automation.effects.Item.PLj8Zv2rN6yztpGl";
const SPELL_SLUG = "forbidden-thought";
const SAVE_OUTCOMES = new Set(["criticalSuccess", "success", "failure", "criticalFailure"]);

// Match the originating spell itself, not arbitrary actor roll options: an
// immune creature can carry the spell name on unrelated attacks and damage.
function isForbiddenThoughtCast(message) {
  const pf2e = message.flags?.pf2e;
  const origin = pf2e?.origin;
  const item = message.item;
  const itemMatches = item?.type === "spell" && item.slug === SPELL_SLUG;
  const originMatches = origin?.type === "spell" && (
    origin.slug === SPELL_SLUG ||
    origin.rollOptions?.includes(`origin:item:slug:${SPELL_SLUG}`) ||
    origin.rollOptions?.includes(`origin:item:${SPELL_SLUG}`)
  );
  const legacyMatches = origin?.slug === SPELL_SLUG && (!origin.type || origin.type === "spell");
  return Boolean(itemMatches || originMatches || legacyMatches);
}

// Warn the GM before casting at a target that is already immune.
async function onCreateChatMessage(message) {
  if (!isActiveGM()) return;

  if (!isForbiddenThoughtCast(message) || message.flags?.pf2e?.context?.type !== "spell-cast") return;
  debug("forbidden-thought", "spell cast detected", message.id);

  const itemSource = await fromUuid(EFFECT_UUID);
  if (!itemSource) return;
  const effectSlug = itemSource.toObject().system.slug;

  const targets = game.user.targets;
  if (targets.size === 0) return;

  const immuneTargetNames = [];
  for (const token of targets) {
    if (token.actor?.itemTypes.effect.some((e) => e.slug === effectSlug)) {
      immuneTargetNames.push(token.name);
    }
  }
  debug("forbidden-thought", "immune targets:", immuneTargetNames);
  if (immuneTargetNames.length === 0) return;

  new Dialog({
    title: "Target is Immune!",
    content: `
      <div style="padding: 5px; font-size: 14px;">
        <p><strong>Warning:</strong> The following target(s) are currently immune to <em>Forbidden Thought</em>:</p>
        <p style="color: #8b0000; font-weight: bold; text-align: center; margin: 10px 0;">${immuneTargetNames.join(", ")}</p>
        <p>Do you still want to cast this spell anyway?</p>
      </div>
    `,
    buttons: {
      yes: {
        icon: '<i class="fas fa-magic"></i>',
        label: "Cast Anyway",
        callback: () => {
          ui.notifications.info("Proceeding with spell cast despite immunity.");
        },
      },
      no: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel Cast",
        callback: async () => {
          await message.delete();
          ui.notifications.warn("Spell cast cancelled and chat card removed.");
        },
      },
    },
    default: "no",
  }).render(true);
}

// Apply immunity once the toolbelt save result lands on the originating spell
// or its damage card. Toolbelt can transfer save data between those cards.
async function onUpdateChatMessage(message, change) {
  if (!isActiveGM()) return;
  if (!isForbiddenThoughtCast(message)) return;

  // Match a save outcome in the changed toolbelt data, not an actor ID appearing
  // anywhere in the update (which may instead refer to damage recipients).
  const toolbeltChange = foundry.utils.expandObject(change ?? {}).flags?.["pf2e-toolbelt"];
  if (!toolbeltChange) return;
  debug("forbidden-thought", "toolbelt update on", message.id, change);

  let source;
  for (const token of game.scenes.current?.tokens ?? []) {
    const actor = token.actor;
    if (!actor) continue;

    let outcome = findOutcome(toolbeltChange, [token.id, actor.id, token.uuid]);

    // Foundry may send only the changed portion of a save entry, omitting its
    // unchanged success value. Use the complete saved result only for the same
    // variant and token explicitly present in this update's saves collection.
    const changedVariants = toolbeltChange.targetHelper?.saveVariants ?? {};
    const storedVariants = message.flags?.["pf2e-toolbelt"]?.targetHelper?.saveVariants ?? {};
    for (const [variantId, variant] of Object.entries(changedVariants)) {
      if (!Object.hasOwn(variant?.saves ?? {}, token.id)) continue;
      outcome ??= storedVariants[variantId]?.saves?.[token.id]?.success;
    }
    if (!SAVE_OUTCOMES.has(outcome)) continue;

    if (!source) {
      const itemSource = await fromUuid(EFFECT_UUID);
      if (!itemSource) return;
      source = itemSource.toObject();
    }

    if (actor.itemTypes.effect.some((e) => e.slug === source.system.slug)) {
      debug("forbidden-thought", `${actor.name} already immune, skipping`);
      continue;
    }

    await actor.createEmbeddedDocuments("Item", [source]);
    ui.notifications.info(`Applied Forbidden Thought immunity to ${actor.name}.`);
  }
}

export default {
  id: "forbidden-thought",
  ready() {
    addDescription(
      SPELL_SLUG,
      "<p><strong>Trigger</strong> The target attempts the forbidden action.</p>" +
        "<p><strong>Basic Will Save</strong></p>" +
        "<ul>" +
        "<li><strong>Critical Success</strong> No damage.</li>" +
        "<li><strong>Success</strong> Half damage.</li>" +
        "<li><strong>Failure</strong> Full damage.</li>" +
        "<li><strong>Critical Failure</strong> Double damage.</li>" +
        "</ul>" +
        "<p>After the save, the target gains immunity: @UUID[" + EFFECT_UUID + "]{Forbidden Thought Immunity}</p>"
    );
    registerHook("forbidden-thought:create", "createChatMessage", onCreateChatMessage);
    registerHook("forbidden-thought:update", "updateChatMessage", onUpdateChatMessage);
  },
};
