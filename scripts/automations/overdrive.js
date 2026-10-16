import { registerHook } from "../lib/hooks.js";
import { isActiveGM } from "../lib/utils.js";
import { debug } from "../lib/debug.js";

const MODULE_ID = "suicidesquid-automation";
const SETTING_CONSTRUCT_UUID = "overdriveConstructUuid";
const ACTION_SLUG = "overdrive";
const ROLL_OPTION = "suicidesquid:overdrive";
const EFFECT_UUID = "Compendium.pf2e.feat-effects.Item.1XlJ9xLzL19GHoOL";
const COOLDOWN_EFFECT_UUID = "Compendium.suicidesquid-automation.effects.Item.ZXilJBgBaMJ04s40";
const EFFECT_SLUG = "effect-overdrive";
const COOLDOWN_SLUG = "suicidesquid-overdrive-cooldown";
const ROUND_SECONDS = 6;
const DC_BY_LEVEL = [
  14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30,
  31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50,
];
const processedRolls = new Set();
const initiatedActions = new Set();

function getActionSlug(message) {
  return message.item?.slug ?? message.flags?.pf2e?.origin?.slug;
}

function getRoundKey(actor) {
  const combat = game.combats?.contents?.find((entry) =>
    entry.combatants?.some((combatant) => combatant.actor?.uuid === actor.uuid)
  );
  if (combat) return `combat:${combat.id}:${combat.round}`;
  return `world:${Math.floor((game.time?.worldTime ?? 0) / ROUND_SECONDS)}`;
}

function getActorOverdriveState(actor) {
  return actor.getFlag(MODULE_ID, "overdrive") ?? {};
}

function hasEffect(actor, slug) {
  return actor.itemTypes.effect.some((effect) => effect.slug === slug);
}

function isLockedOut(actor) {
  // Overdrive can be used again while its effect is active, but the cooldown
  // effect blocks new uses after Overdrive itself has ended.
  return hasEffect(actor, COOLDOWN_SLUG) && !hasEffect(actor, EFFECT_SLUG);
}

function levelDC(actor) {
  const level = Math.max(0, Math.min(25, Number(actor.level ?? actor.system?.details?.level?.value ?? 0)));
  return DC_BY_LEVEL[level];
}

function confirmOverdriveRetry() {
  return new Promise((resolve) => {
    new Dialog({
      title: "Overdrive Already Active",
      content: "<p>You are already under the effects of Overdrive. You can try again to turn it into a critical overdrive, but the duration will not be extended. A failure has no effect, and a critical failure ends Overdrive.</p><p>Attempt Overdrive again?</p>",
      buttons: {
        yes: { icon: '<i class="fas fa-check"></i>', label: "Attempt", callback: () => resolve(true) },
        no: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(false) },
      },
      default: "no",
      close: () => resolve(false),
    }).render(true);
  });
}

async function startCraftingCheck(message) {
  const actor = message.actor;
  if (!actor || message.author?.id !== game.user.id || getActionSlug(message) !== ACTION_SLUG) return;
  if (initiatedActions.has(message.id)) return;
  initiatedActions.add(message.id);

  const worldTime = game.time?.worldTime ?? 0;
  const state = getActorOverdriveState(actor);
  const overdriveActive = hasEffect(actor, EFFECT_SLUG);
  if (isLockedOut(actor) && !overdriveActive) {
    ui.notifications.warn("Overdrive is still cooling down.");
    return;
  }

  if (overdriveActive && !(await confirmOverdriveRetry())) return;

  const roundKey = getRoundKey(actor);
  if (state.lastUseRound === roundKey) {
    ui.notifications.warn("Overdrive can only be used once per round.");
    return;
  }

  const crafting = actor.skills?.crafting ?? actor.getStatistic?.("crafting");
  if (typeof crafting?.check?.roll !== "function") {
    ui.notifications.error("Overdrive: could not find the PF2e Crafting check API on this actor.");
    return;
  }

  const dc = levelDC(actor);
  if (!Number.isFinite(dc)) {
    ui.notifications.error("Overdrive: could not determine the standard DC for this actor's level.");
    return;
  }

  // Reserve the once-per-round use before rolling to prevent rapid repeated clicks.
  await actor.setFlag(MODULE_ID, "overdrive", {
    ...state,
    lastUseRound: roundKey,
    lastUseAt: worldTime,
    pendingRoll: { actionMessageId: message.id, startedAt: Date.now() },
  });

  debug("overdrive", "starting Crafting check", { actor: actor.name, dc, roundKey });
  try {
    await crafting.check.roll({
      dc: { value: dc },
      options: [ROLL_OPTION],
      event: new MouseEvent("click"),
      title: "Overdrive — Crafting",
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Overdrive Crafting check failed`, error);
    ui.notifications.error("Overdrive: the Crafting check could not be rolled. The once-per-round use was released.");
    const latest = getActorOverdriveState(actor);
    await actor.setFlag(MODULE_ID, "overdrive", {
      ...latest,
      lastUseRound: null,
      lastUseAt: null,
      pendingRoll: null,
    });
  }
}

function getOutcome(message) {
  const context = message.flags?.pf2e?.context;
  if (!context?.outcome) return null;
  if (JSON.stringify(context).includes(ROLL_OPTION)) return context.outcome;

  // Some PF2e releases don't retain custom check options on the chat message.
  // In that case, only accept a Crafting check from this actor while its Overdrive
  // action is pending. The pending request itself was created specifically for
  // Crafting, and the result must be that actor's skill-check within 30 seconds.
  const actor = message.actor;
  const pending = actor ? getActorOverdriveState(actor).pendingRoll : null;
  const pendingAge = pending ? Date.now() - pending.startedAt : Infinity;
  if (
    actor &&
    pending &&
    pendingAge >= 0 &&
    pendingAge < 30_000 &&
    context.type === "skill-check"
  ) {
    return context.outcome;
  }
  return null;
}

async function findEffectSource() {
  const document = await fromUuid(EFFECT_UUID);
  if (!document) throw new Error(`Could not load the Overdrive effect ${EFFECT_UUID}.`);
  return document.toObject();
}

function customizeEffect(source, outcome, actor) {
  const effect = foundry.utils.deepClone(source);
  const selection = {
    criticalSuccess: "critical-success",
    success: "success",
    failure: "failure",
  }[outcome];
  if (!selection) return null;

  // PF2e reads a ChoiceSet's `selection` property during pre-creation to decide
  // whether to show its prompt. The rulesSelections flag is only the persisted
  // result, so set both values on the source before creating the embedded effect.
  const choiceSet = effect.system.rules?.find((rule) => rule.key === "ChoiceSet" && rule.flag === "baseDamage");
  if (!choiceSet) throw new Error("The Overdrive effect has no baseDamage ChoiceSet.");
  choiceSet.selection = selection;
  foundry.utils.setProperty(effect, "flags.pf2e.rulesSelections.baseDamage", selection);
  return effect;
}

function getConstructActor() {
  const uuid = game.settings.get(MODULE_ID, SETTING_CONSTRUCT_UUID)?.trim();
  if (!uuid) return null;
  return fromUuidSync(uuid);
}

async function applyOverdrive(actor, outcome, effectTemplate, message) {
  const source = customizeEffect(effectTemplate, outcome, actor);
  if (!source) return;

  const construct = getConstructActor();
  if (!construct) {
    ui.notifications.warn("Overdrive applied to the inventor, but the construct actor is not configured or could not be found. Set the Overdrive construct actor UUID in module settings.");
  }

  const targets = [...new Set([actor, construct].filter(Boolean))];
  const existingByTarget = new Map(targets.map((target) => [
    target,
    target.itemTypes.effect.filter((effect) => effect.slug === EFFECT_SLUG),
  ]));
  const hasCurrentOverdrive = [...existingByTarget.values()].some((effects) => effects.length > 0);

  // A new use cannot refresh an active Overdrive. Only a critical success upgrades it.
  if (hasCurrentOverdrive && ["failure", "success"].includes(outcome)) {
    ui.notifications.info(outcome === "failure"
      ? "The failed Overdrive attempt has no effect on your current Overdrive."
      : "The current Overdrive is unchanged; using Overdrive again does not extend its duration.");
    return null;
  }
  if (outcome === "criticalSuccess" && [...existingByTarget.values()].some((effects) =>
    effects.some((effect) => effect.flags?.pf2e?.rulesSelections?.baseDamage === "critical-success")
  )) {
    ui.notifications.info("The current Critical Overdrive is unchanged.");
    return null;
  }

  if (hasCurrentOverdrive && outcome === "criticalSuccess") {
    // Upgrade existing effects in place. Deleting and recreating an effect resets
    // its duration clock, contrary to Overdrive's rule that retries don't extend it.
    const timingEffect = existingByTarget.get(actor)?.[0] ??
      [...existingByTarget.values()].find((effects) => effects.length)?.[0];
    const appliedAt = Number(
      timingEffect?.flags?.[MODULE_ID]?.overdrive?.appliedAt ?? game.time?.worldTime ?? 0
    );

    for (const target of targets) {
      const existing = existingByTarget.get(target);
      if (existing.length) {
        const [primary, ...duplicates] = existing;
        await primary.update({
          name: source.name,
          img: source.img,
          "system.rules": source.system.rules,
          "flags.pf2e.rulesSelections.baseDamage": "critical-success",
        });
        if (duplicates.length) {
          await target.deleteEmbeddedDocuments("Item", duplicates.map((effect) => effect.id));
        }
        continue;
      }

      // If the construct didn't receive the original effect, sync it to the
      // inventor's existing duration clock instead of starting a fresh minute.
      const targetSource = foundry.utils.deepClone(source);
      if (timingEffect) {
        targetSource.system.duration = foundry.utils.deepClone(timingEffect.system.duration);
        targetSource.system.start = foundry.utils.deepClone(timingEffect.system.start);
      }
      targetSource.system.context = targetSource.system.context ?? {};
      targetSource.system.context.origin = {
        actor: actor.uuid,
        token: null,
        item: message.item?.uuid ?? message.flags?.pf2e?.origin?.uuid ?? null,
        spellcasting: null,
      };
      foundry.utils.setProperty(targetSource, `flags.${MODULE_ID}.overdrive.appliedAt`, appliedAt);
      await target.createEmbeddedDocuments("Item", [targetSource]);
    }

    ui.notifications.info(`Critical Overdrive upgraded without extending its duration for ${targets.map((target) => target.name).join(" and ")}.`);
    return { appliedAt, upgraded: true };
  }

  const appliedAt = hasCurrentOverdrive
    ? Number(existingByTarget.get(actor)?.[0]?.flags?.[MODULE_ID]?.overdrive?.appliedAt ?? game.time?.worldTime ?? 0)
    : (game.time?.worldTime ?? 0);
  for (const target of targets) {
    const targetSource = foundry.utils.deepClone(source);
    const existing = existingByTarget.get(target);
    if (existing.length) {
      targetSource.system.duration = foundry.utils.deepClone(existing[0].system.duration);
    }
    targetSource.system.context = targetSource.system.context ?? {};
    targetSource.system.context.origin = {
      actor: actor.uuid,
      token: null,
      item: message.item?.uuid ?? message.flags?.pf2e?.origin?.uuid ?? null,
      spellcasting: null,
    };
    targetSource.flags = targetSource.flags ?? {};
    foundry.utils.setProperty(targetSource, `flags.${MODULE_ID}.overdrive.appliedAt`, appliedAt);

    if (existing.length) await target.deleteEmbeddedDocuments("Item", existing.map((effect) => effect.id));
    await target.createEmbeddedDocuments("Item", [targetSource]);
  }

  ui.notifications.info(`${outcome === "criticalSuccess" ? "Critical Overdrive" : "Overdrive"} applied to ${targets.map((target) => target.name).join(" and ")}.`);
  return { appliedAt };
}

async function endOverdrive(actor) {
  const construct = getConstructActor();
  const targets = [...new Set([actor, construct].filter(Boolean))];
  for (const target of targets) {
    const effects = target.itemTypes.effect.filter((effect) => effect.slug === EFFECT_SLUG);
    if (effects.length) await target.deleteEmbeddedDocuments("Item", effects.map((effect) => effect.id));
  }
  if (targets.length > 1) {
    ui.notifications.info(`Critical failure ends Overdrive on ${targets.map((target) => target.name).join(" and ")}.`);
  }
}

async function applyFireDamage(actor, amount) {
  const damageAmount = Math.trunc(Number(amount));
  if (!Number.isFinite(damageAmount) || damageAmount <= 0) return;
  if (typeof actor.applyDamage !== "function") {
    ui.notifications.error("Overdrive: this PF2e actor does not expose applyDamage(); critical-failure damage was not applied automatically.");
    return;
  }

  const token = actor.getActiveTokens(false, true)[0] ?? actor.token;
  if (!token) {
    ui.notifications.error("Overdrive: critical-failure fire damage could not be applied because the inventor has no active token.");
    return;
  }

  const DamageRollClass = CONFIG.Dice.rolls.find((RollClass) => RollClass.name === "DamageRoll");
  if (!DamageRollClass) {
    ui.notifications.error("Overdrive: PF2e DamageRoll is unavailable; critical-failure damage was not applied.");
    return;
  }

  const damage = await new DamageRollClass(`(${damageAmount})[fire]`).evaluate();
  await actor.applyDamage({ damage, token, item: null });
}

async function applyCooldownEffect(actor, value, unit, outcome) {
  // The cooldown marker starts with Overdrive and remains for one minute after
  // its one-minute effect expires. Do not refresh it on repeat attempts.
  if (hasEffect(actor, COOLDOWN_SLUG)) return;

  const cooldownDocument = await fromUuid(COOLDOWN_EFFECT_UUID);
  if (!cooldownDocument) {
    throw new Error(`Could not load module Overdrive Cooldown effect ${COOLDOWN_EFFECT_UUID}. Import overdrive-cooldown-effect.json into the module effects pack.`);
  }
  const source = cooldownDocument.toObject();
  source.system.description = {
    value: outcome === "criticalSuccess"
      ? "<p>Your gizmos need to cool down after Overdrive. This cooldown expires one minute after your Overdrive effect ends.</p>"
      : "<p>Your gizmos are resetting after a failed Overdrive attempt.</p>",
    gm: "",
  };
  source.system.rules = [];
  source.system.duration = {
    expiry: "turn-start",
    sustained: false,
    unit,
    value,
  };
  source.system.context = null;
  source.flags = source.flags ?? {};
  delete source.flags.pf2e?.rulesSelections;
  foundry.utils.setProperty(source, `flags.${MODULE_ID}.overdriveCooldown`, { outcome });

  const existing = actor.itemTypes.effect.filter((effect) => effect.slug === COOLDOWN_SLUG);
  if (existing.length) await actor.deleteEmbeddedDocuments("Item", existing.map((effect) => effect.id));
  await actor.createEmbeddedDocuments("Item", [source]);
}

async function setCooldown(actor, outcome) {
  if (outcome === "criticalSuccess" || outcome === "success") {
    // One minute of Overdrive plus the required one-minute cooldown afterward.
    // The cooldown effect tracks both minutes, while the use check allows
    // another Overdrive attempt until the Overdrive effect itself has ended.
    await applyCooldownEffect(actor, 2, "minutes", outcome);
  } else if (outcome === "criticalFailure") {
    const roll = await new Roll("1d4").evaluate();
    const rounds = roll.total;
    await roll.toMessage({ flavor: `Overdrive reset: ${rounds} round${rounds === 1 ? "" : "s"}.` });
    await applyCooldownEffect(actor, rounds, "rounds", outcome);
  }
}

async function onCreateChatMessage(message) {
  // The action card starts a check on its author's client; a marked result is processed once by the GM.
  await startCraftingCheck(message);
  if (!isActiveGM()) return;

  const context = message.flags?.pf2e?.context;
  if (context?.type?.includes("skill") || context?.outcome) {
    debug("overdrive", "chat roll observed", {
      id: message.id,
      actor: message.actor?.name,
      author: message.author?.name,
      type: context.type,
      skill: context.skill,
      statistic: context.statistic,
      options: context.options,
      domains: context.domains,
      outcome: context.outcome,
      pending: message.actor ? getActorOverdriveState(message.actor).pendingRoll : null,
    });
  }

  const outcome = getOutcome(message);
  if (!outcome || processedRolls.has(message.id)) return;
  processedRolls.add(message.id);
  const actor = message.actor;
  if (!actor) return;

  const state = getActorOverdriveState(actor);
  const priorRolls = state.processedRolls ?? [];
  if (priorRolls.includes(message.id)) return;
  await actor.setFlag(MODULE_ID, "overdrive", {
    ...state,
    processedRolls: [...priorRolls, message.id].slice(-20),
    pendingRoll: null,
  });

  debug("overdrive", "Crafting result", { actor: actor.name, outcome, context: message.flags?.pf2e?.context });
  try {
    if (outcome === "criticalFailure") {
      await applyFireDamage(actor, Math.ceil(Number(actor.level ?? 0) / 2));
      await endOverdrive(actor);
      await setCooldown(actor, outcome);
    } else if (["criticalSuccess", "success", "failure"].includes(outcome)) {
      const template = await findEffectSource();
      const applied = await applyOverdrive(actor, outcome, template, message);
      if (["criticalSuccess", "success"].includes(outcome) && applied) {
        await setCooldown(actor, outcome);
      }
    } else {
      return;
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Overdrive result processing failed`, error);
    ui.notifications.error(`Overdrive: could not process the ${outcome} result. See the console for details.`);
  }
}

export default {
  id: "overdrive",
  init() {
    game.settings.register(MODULE_ID, SETTING_CONSTRUCT_UUID, {
      name: "Overdrive Construct Actor UUID",
      hint: "UUID of the inventor's separate construct actor; leave blank to apply Overdrive only to the inventor.",
      scope: "world",
      config: true,
      type: String,
      default: "",
    });
  },
  ready() {
    registerHook("overdrive:create", "createChatMessage", onCreateChatMessage);
  },
};
