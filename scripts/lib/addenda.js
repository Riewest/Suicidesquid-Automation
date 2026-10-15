import { registerHook } from "./hooks.js";
import { debug } from "./debug.js";

const addenda = new Map();

// Selector is a best guess at the PF2e spell card body; falls back to the whole message content.
const CARD_SELECTORS = [".card-content", ".description"];

function onRender(message, html) {
  const slug = message.item?.slug ?? message.flags?.pf2e?.origin?.slug;
  debug("addenda", "render", { slug, origin: message.flags?.pf2e?.origin });
  const text = slug && addenda.get(slug);
  if (!text) return;

  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector(".suicidesquid-addendum")) return;

  const target =
    CARD_SELECTORS.map((s) => root.querySelector(s)).find(Boolean) ??
    root.querySelector(".message-content") ??
    root;
  debug("addenda", `injecting for ${slug}`);

  const note = document.createElement("div");
  note.className = "suicidesquid-addendum";
  target.append(note);

  // Enrichment turns @UUID[...] into draggable content links.
  const enricher = foundry.applications.ux.TextEditor.implementation;
  enricher.enrichHTML(`<hr>${text}`).then((enriched) => {
    note.innerHTML = enriched;
  });
}

/** Appends extra HTML to the chat card of the spell/item with the given slug. */
export function addDescription(slug, html) {
  addenda.set(slug, html);
  registerHook("addenda:render", "renderChatMessageHTML", onRender);
}
