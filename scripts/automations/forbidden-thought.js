import { registerHook } from "../lib/hooks.js";
import { isActiveGM, messageHasSpellSlug } from "../lib/utils.js";
import { debug } from "../lib/debug.js";
import { addDescription } from "../lib/addenda.js";

const EFFECT_UUID = "Compendium.suicidesquid-automation.effects.Item.PLj8Zv2rN6yztpGl";
const SPELL_SLUG = "forbidden-thought";

// Warn the GM before casting at a target that is already immune.
async function onCreateChatMessage(message) {
  if (!isActiveGM()) return;

  const isSpellCast = message.flags?.pf2e?.context?.type === "spell-cast";
  if (!isSpellCast || !messageHasSpellSlug(message, SPELL_SLUG)) return;
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

// Apply immunity once the toolbelt save result lands on the message.
async function onUpdateChatMessage(message, change) {
  if (!isActiveGM()) return;
  if (!messageHasSpellSlug(message, SPELL_SLUG)) return;

  const changeString = JSON.stringify(change ?? {});
  if (!changeString.includes("pf2e-toolbelt")) return;
  debug("forbidden-thought", "toolbelt update on", message.id, change);

  for (const token of game.scenes.current?.tokens ?? []) {
    const actor = token.actor;
    if (!actor) continue;

    const matchesTarget =
      changeString.includes(token.id) ||
      changeString.includes(actor.id) ||
      changeString.includes(token.uuid);
    if (!matchesTarget) continue;

    const itemSource = await fromUuid(EFFECT_UUID);
    if (!itemSource) return;
    const source = itemSource.toObject();

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
