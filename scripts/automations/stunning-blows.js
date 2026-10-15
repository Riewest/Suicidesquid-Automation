import { registerHook } from "../lib/hooks.js";
import { isActiveGM, findOutcome } from "../lib/utils.js";
import { debug } from "../lib/debug.js";

const MODULE_ID = "suicidesquid-automation";
const FLURRY_SLUG = "flurry-of-blows";
const FEAT_SLUG = "stunning-blows";
const DESCRIPTION =
  "<p>The focused power of your flurry threatens to overwhelm your opponent. When you target the same creature with two Strikes from your " +
  "@UUID[Compendium.pf2e.actionspf2e.Item.nbfNETdpee8CVM17]{Flurry of Blows}, you can try to stun the creature. " +
  "If either Strike hits and deals damage, the target must succeed at a Fortitude save against your class DC or be " +
  "@UUID[Compendium.pf2e.conditionitems.Item.dfCMdR4wnpbYNTix]{Stunned 1} (or " +
  "@UUID[Compendium.pf2e.conditionitems.Item.dfCMdR4wnpbYNTix]{Stunned 3} on a critical failure). " +
  "This is an incapacitation effect.</p>";
const SAVE_OPTION = "stunning-blows";
const LEVEL_OPTION_PREFIX = "stunning-blows-level:";
const STUN_BY_OUTCOME = { failure: 1, criticalFailure: 3 };
const OUTCOME_ORDER = ["criticalFailure", "failure", "success", "criticalSuccess"];

function confirm(title, content) {
  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<p style="padding: 5px;">${content}</p>`,
      buttons: {
        yes: { icon: '<i class="fas fa-check"></i>', label: "Yes", callback: () => resolve(true) },
        no: { icon: '<i class="fas fa-times"></i>', label: "No", callback: () => resolve(false) },
      },
      default: "yes",
      close: () => resolve(false),
    }).render(true);
  });
}

function chooseStrike(strikes) {
  return new Promise((resolve) => {
    const options = strikes.map((s, i) => `<option value="${i}">${foundry.utils.escapeHTML(s.label)}</option>`).join("");
    new Dialog({
      title: "Stunning Blows",
      content: `<p style="padding: 5px;">Which unarmed attack?</p><select id="sb-strike" style="width: 100%;">${options}</select>`,
      buttons: {
        ok: {
          icon: '<i class="fas fa-fist-raised"></i>',
          label: "Strike",
          callback: (html) => resolve(strikes[Number(html.find("#sb-strike").val())]),
        },
      },
      default: "ok",
      close: () => resolve(null),
    }).render(true);
  });
}

function getClassDC(actor) {
  return actor.classDC?.dc?.value ?? actor.system?.attributes?.classDC?.value ?? actor.system?.proficiencies?.classDC?.value;
}

// Runs on the client of the player who used Flurry of Blows.
async function onFlurry(message) {
  if (message.author?.id !== game.user.id) return;

  const slug = message.item?.slug ?? message.flags?.pf2e?.origin?.slug;
  debug("stunning-blows", "message", { slug, origin: message.flags?.pf2e?.origin });
  if (slug !== FLURRY_SLUG) return;

  const actor = message.actor;
  if (!actor?.itemTypes.feat.some((f) => f.slug === FEAT_SLUG)) return;

  const target = game.user.targets.first();
  if (!target) return;

  if (!(await confirm("Stunning Blows", `Is this Flurry of Blows against <strong>${target.name}</strong> a Stunning Blows attempt?`))) return;

  const strikes = actor.system.actions.filter((a) => a.visible !== false && a.item?.category === "unarmed");
  if (strikes.length === 0) return ui.notifications.warn("No unarmed strikes found.");

  const strike = strikes.length === 1 ? strikes[0] : await chooseStrike(strikes);
  if (!strike) return;

  const event = new MouseEvent("click");
  // Variant 0 is the first Strike; variant 1 carries the multiple attack penalty.
  await strike.variants[0]?.roll({ event });
  await strike.variants[1]?.roll({ event });

  const dc = getClassDC(actor);
  if (dc === undefined) return ui.notifications.warn("Could not determine class DC.");

  const options = `${SAVE_OPTION},${LEVEL_OPTION_PREFIX}${actor.level}`;
  const feat = actor.itemTypes.feat.find((f) => f.slug === FEAT_SLUG);
  const enricher = foundry.applications.ux.TextEditor.implementation;
  const body = await enricher.enrichHTML(DESCRIPTION, { relativeTo: feat });
  const check = await enricher.enrichHTML(`@Check[fortitude|dc:${dc}|traits:incapacitation|options:${options}]`, { relativeTo: feat });

  // Mimics a feat card so toolbelt treats it as an action message and adds target saves to the footer.
  const content =
    `<div class="pf2e chat-card action-card" data-actor-id="${actor.id}" data-item-id="${feat?.id ?? ""}">` +
    `<header class="card-header flexrow"><img src="${feat?.img ?? ""}" width="36" height="36"><h3>Stunning Blows</h3></header>` +
    `<div class="card-content">${body}</div>` +
    `<div class="card-buttons">${check}</div></div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      pf2e: { origin: { type: "feat", uuid: feat?.uuid, slug: FEAT_SLUG } },
      [MODULE_ID]: { stunningBlows: { level: actor.level } },
    },
  });
}

async function applyStun(actor, rawOutcome, attackerLevel) {
  let outcome = rawOutcome;

  // Incapacitation: a higher-level target gets one degree of success better.
  if (Number.isFinite(attackerLevel) && actor.level > attackerLevel) {
    const index = OUTCOME_ORDER.indexOf(outcome);
    if (index >= 0) outcome = OUTCOME_ORDER[Math.min(index + 1, OUTCOME_ORDER.length - 1)];
  }
  debug("stunning-blows", "apply", { actor: actor.name, rawOutcome, outcome, attackerLevel });

  const value = STUN_BY_OUTCOME[outcome];
  if (!value) return;

  const existing = actor.getCondition?.("stunned")?.value ?? 0;
  if (existing >= value) return;
  if (existing > 0) await actor.decreaseCondition("stunned", { forceRemove: true });
  await actor.increaseCondition("stunned", { value });
  ui.notifications.info(`${actor.name} is Stunned ${value} by Stunning Blows.`);
}

// Path 1: the toolbelt target helper stores each target's result on the card message.
async function onCardUpdate(message, change) {
  if (!isActiveGM()) return;
  const data = message.flags?.[MODULE_ID]?.stunningBlows;
  if (!data) return;

  const changeString = JSON.stringify(change ?? {});
  if (!changeString.includes("pf2e-toolbelt")) return;
  debug("stunning-blows", "card update", { flags: message.flags, change });

  for (const token of game.scenes.current?.tokens ?? []) {
    const actor = token.actor;
    if (!actor) continue;
    if (!(changeString.includes(token.id) || changeString.includes(actor.id) || changeString.includes(token.uuid))) continue;

    const outcome = findOutcome(message.flags["pf2e-toolbelt"], [token.id, actor.id, token.uuid]);
    if (outcome) await applyStun(actor, outcome, data.level);
  }
}

// Path 2: a regular saving-throw message tagged with our roll option.
async function onSave(message) {
  if (!isActiveGM()) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "saving-throw" || !context.options?.includes(SAVE_OPTION)) return;
  if (!message.actor) return;

  const levelOption = context.options.find((o) => o.startsWith(LEVEL_OPTION_PREFIX));
  await applyStun(message.actor, context.outcome, Number(levelOption?.slice(LEVEL_OPTION_PREFIX.length)));
}

export default {
  id: "stunning-blows",
  ready() {
    registerHook("stunning-blows:flurry", "createChatMessage", onFlurry);
    registerHook("stunning-blows:save", "createChatMessage", onSave);
    registerHook("stunning-blows:card", "updateChatMessage", onCardUpdate);
  },
};
