export function isActiveGM() {
  return game.user === game.users.activeGM;
}

export function messageHasSpellSlug(message, slug) {
  return (
    message.flags?.pf2e?.origin?.slug === slug ||
    message.flags?.pf2e?.context?.options?.some((o) => o.includes(slug))
  );
}

// Finds the save outcome the toolbelt stored for this token anywhere in its flags.
export function findOutcome(node, keys, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  for (const [key, value] of Object.entries(node)) {
    if (keys.includes(key) && value && typeof value === "object") {
      const outcome = value.success ?? value.outcome;
      if (typeof outcome === "string") return outcome;
    }
    const nested = findOutcome(value, keys, depth + 1);
    if (nested) return nested;
  }
  return null;
}
