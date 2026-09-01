export type SmartListKind = "keywords" | "lines";

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
