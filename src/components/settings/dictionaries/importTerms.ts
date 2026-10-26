import type { DictionaryEntry } from "@/bindings";

export interface ImportPreview {
  entries: DictionaryEntry[];
  addedTerms: string[];
  addedVariants: string[];
  duplicates: string[];
  invalid: string[];
  conflicts: string[];
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const keyOf = (value: string) => value.toLowerCase();
const validText = (value: string) =>
  value.length > 0 && Array.from(value).length <= 100 && !/\p{Cc}/u.test(value);

export function parseTermList(
  text: string,
  existing: DictionaryEntry[],
): ImportPreview {
  const entries = existing.map((entry) => ({
    ...entry,
    variants: [...entry.variants],
  }));
  const termIndexes = new Map(
    entries.map((entry, index) => [keyOf(entry.term), index]),
  );
  const variantOwners = new Map(
    entries.flatMap((entry) =>
      entry.variants.map(
        (variant) => [keyOf(variant), keyOf(entry.term)] as const,
      ),
    ),
  );
  const preview: ImportPreview = {
    entries,
    addedTerms: [],
    addedVariants: [],
    duplicates: [],
    invalid: [],
    conflicts: [],
  };

  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim();
    if (!content || /^(?:[-*•]|\d+[.)])$/.test(content)) continue;

    const parts = content.split("=>");
    if (parts.length > 2) {
      preview.invalid.push(content);
      continue;
    }
    const term = normalize(parts[0]);
    const variants = parts[1]?.split("|").map(normalize) ?? [];
    if (
      !validText(term) ||
      (parts.length === 2 && variants.some((variant) => !validText(variant)))
    ) {
      preview.invalid.push(content);
      continue;
    }

    const termKey = keyOf(term);
    const uniqueVariants = [
      ...new Map(variants.map((variant) => [keyOf(variant), variant])).values(),
    ];
    if (
      uniqueVariants.some((variant) => {
        const owner = variantOwners.get(keyOf(variant));
        return owner !== undefined && owner !== termKey;
      })
    ) {
      preview.conflicts.push(content);
      continue;
    }

    let index = termIndexes.get(termKey);
    const isNewTerm = index === undefined;
    if (index === undefined) {
      index = entries.length;
      entries.push({ term, variants: [] });
      termIndexes.set(termKey, index);
      preview.addedTerms.push(term);
    }
    const entry = entries[index];
    let added = 0;
    for (const variant of uniqueVariants) {
      const variantKey = keyOf(variant);
      if (variantOwners.has(variantKey)) continue;
      entry.variants.push(variant);
      variantOwners.set(variantKey, termKey);
      preview.addedVariants.push(`${entry.term}: ${variant}`);
      added++;
    }
    if (!isNewTerm && added === 0) preview.duplicates.push(term);
  }
  return preview;
}
