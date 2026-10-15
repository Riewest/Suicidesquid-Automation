export function isActiveGM() {
  return game.user === game.users.activeGM;
}

export function messageHasSpellSlug(message, slug) {
  return (
    message.flags?.pf2e?.origin?.slug === slug ||
    message.flags?.pf2e?.context?.options?.some((o) => o.includes(slug))
  );
}
