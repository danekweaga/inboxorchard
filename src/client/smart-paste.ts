export type SmartListKind = "keywords" | "lines";
export type AiListPromptKind = "keywords" | "public_replies" | "intent_examples";

/** Turn copied comma/newline lists or numbered/bulleted text into clean, unique items. */
export function parseSmartList(value: string, kind: SmartListKind): string[] {
  const separator = kind === "keywords" ? /\r?\n|[,;\t]/ : /\r?\n/;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value.split(separator)) {
    const item = raw
      .replace(/^\s*(?:[-*•▪◦‣]+|\d{1,3}[.)]|[a-zA-Z][.)])\s+/, "")
      .trim()
      .replace(/^["“”']+|["“”']+$/g, "")
      .trim();
    if (!item) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function buildAiListPrompt(kind: AiListPromptKind, noun = "Instagram message"): string {
  const outputRule = "Output only the finished items, one per line. Do not add numbering, bullets, quotation marks, headings, or explanations.";
  if (kind === "keywords") return [
    "Help me configure an Instagram automation.",
    `Generate 20 realistic keywords or short phrases someone might use in a ${noun.toLowerCase()} to request my offer.`,
    "Offer/topic: [DESCRIBE THE OFFER OR CONTENT HERE]",
    "Include concise variations, common wording, and likely spelling variations. Avoid long sentences and duplicates.",
    outputRule,
  ].join("\n");
  if (kind === "public_replies") return [
    "Write 10 short public Instagram comment replies for people who requested something and should now check their DMs.",
    "Offer/topic: [DESCRIBE THE OFFER OR CONTENT HERE]",
    "Keep each reply friendly, natural, and under 12 words. Vary the wording and emojis without sounding spammy.",
    outputRule,
  ].join("\n");
  return [
    "Help me train an Instagram automation to recognize an intent.",
    "Intent: [DESCRIBE WHAT THE PERSON WANTS HERE]",
    "Generate 20 realistic DMs a person might send when they have that intent. Include short, casual, indirect, and typo-style variations.",
    outputRule,
  ].join("\n");
}
