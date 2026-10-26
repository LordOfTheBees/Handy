import assert from "node:assert/strict";
import { parseTermList } from "./importTerms";

assert.deepEqual(
  parseTermList("- MacBook Pro\n1. OpenAI\r\n• Проект Альфа\n* OpenAI\n2.", []),
  {
    entries: [
      { term: "MacBook Pro", variants: [] },
      { term: "OpenAI", variants: [] },
      { term: "Проект Альфа", variants: [] },
    ],
    addedTerms: ["MacBook Pro", "OpenAI", "Проект Альфа"],
    addedVariants: [],
    duplicates: ["OpenAI"],
    invalid: [],
    conflicts: [],
  },
);

const preview = parseTermList(`handy\n${"x".repeat(101)}\nGPT-4`, [
  { term: "Handy", variants: [] },
]);
assert.deepEqual(preview.addedTerms, ["GPT-4"]);
assert.deepEqual(preview.duplicates, ["handy"]);
assert.equal(preview.invalid.length, 1);

const existing = [
  { term: "Handy", variants: ["хэнди"] },
  { term: "Claude", variants: ["cloud"] },
];
const withVariants = parseTermList(
  "- Handy => Хэнди | Ханди\n1. Обсидиан => об сидят | обседеан\n* обсидиан => Обсидиян\nClaude => cloud | клод\nOther => cloud\nBad => good |",
  existing,
);
assert.deepEqual(withVariants.entries, [
  { term: "Handy", variants: ["хэнди", "Ханди"] },
  { term: "Claude", variants: ["cloud", "клод"] },
  { term: "Обсидиан", variants: ["об сидят", "обседеан", "Обсидиян"] },
]);
assert.deepEqual(withVariants.addedTerms, ["Обсидиан"]);
assert.deepEqual(withVariants.addedVariants, [
  "Handy: Ханди",
  "Обсидиан: об сидят",
  "Обсидиан: обседеан",
  "Обсидиан: Обсидиян",
  "Claude: клод",
]);
assert.deepEqual(withVariants.conflicts, ["Other => cloud"]);
assert.deepEqual(withVariants.invalid, ["Bad => good |"]);
assert.deepEqual(existing[0].variants, ["хэнди"]);

const repeated = parseTermList(
  "Alpha => a | a\nAlpha => a\nBeta => a\nGamma => x",
  [],
);
assert.deepEqual(repeated.entries, [
  { term: "Alpha", variants: ["a"] },
  { term: "Gamma", variants: ["x"] },
]);
assert.deepEqual(repeated.duplicates, ["Alpha"]);
assert.deepEqual(repeated.conflicts, ["Beta => a"]);

const variantOnly = parseTermList("Handy => хэнди | хэнди2", existing);
assert.deepEqual(variantOnly.addedTerms, []);
assert.deepEqual(variantOnly.addedVariants, ["Handy: хэнди2"]);
assert.deepEqual(parseTermList(`Valid => ${"x".repeat(101)}`, []).invalid, [
  `Valid => ${"x".repeat(101)}`,
]);

console.log("dictionary import: all assertions passed");
