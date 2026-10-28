# Holdout file format

`npm run holdout -- /path/to/file.json` scores a file that stays outside the repository. The script uses the same `analyze`, `scoreChat`, and `buildOptions` functions as the product. Property rows come from `fixtures/intl/testset.json` unless the file defines its own.

```json
{
  "messages": [
    {
      "id": "H01",
      "text": "message text",
      "kind": "text",
      "property_id": "P1",
      "sender_name": "Optional",
      "expected": { "intent": "viewing", "language": "en", "grade": "HOT" }
    }
  ]
}
```

`kind` may be `non_text`. `property_id` P1–P4 match the demo properties (Dubai Marina rent AED / year, Beşiktaş sale USD, Canggu rent USD / month, Business Bay rent AED / year). A `properties` object in the file overrides those rows. The script prints intent, language, and grade hits, false and missed STOP counts, and how many stop or unclear messages still produced a reply option.

The process exits 0 only when every message that states `expected.intent`, `expected.language`, or `expected.grade` matches, there is no false STOP and no missed STOP, and no stop or unclear message still has a reply option. Anything short of that exits 1. A missing file exits 2. Fields you omit are not counted.
