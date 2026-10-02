import assert from "node:assert/strict";
import test from "node:test";
import { partSearchTerms } from "./partSearch";

test("targeted part searches become terms that may match separate fields", () => {
  assert.deepEqual(partSearchTerms("2017 Toyota Camry oil filter"), [
    "2017",
    "toyota",
    "camry",
    "oil",
    "filter",
  ]);
});

test("search terms normalize punctuation, case, duplicates, and limits", () => {
  assert.deepEqual(partSearchTerms("Oil-filter OIL / Camry"), [
    "oil",
    "filter",
    "camry",
  ]);
  assert.equal(
    partSearchTerms("one two three four five six seven eight nine ten eleven twelve thirteen").length,
    12,
  );
});
