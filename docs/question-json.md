# Question JSON format

Choose **Import JSON** in the game editor. Paste a single JSON object with this shape:

```json
{
  "title": "My game",
  "categories": [
    {
      "name": "Science",
      "questions": [
        {
          "value": 200,
          "question": "Which planet is known as the Red Planet?",
          "answer": "Mars",
          "notes": "Also accept: the fourth planet",
          "dailyDouble": true
        }
      ]
    }
  ],
  "final": {
    "category": "World Landmarks",
    "question": "Which Indian mausoleum was commissioned by Shah Jahan?",
    "answer": "The Taj Mahal"
  }
}
```

Categories appear left to right in array order. Questions appear top to bottom in each category's array. Internal question IDs are generated automatically.

| Field                | Validation                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `title`              | Required, 1–100 characters after trimming                         |
| `categories`         | 1–8 categories; names unique ignoring case                        |
| Category `name`      | Required, 1–80 characters                                         |
| Category `questions` | 1–8 entries; equal count across every category                    |
| `value`              | Required integer from 1 through 100,000; numeric strings rejected |
| `question`           | Required, 1–3,000 characters                                      |
| `answer`             | Required, 1–2,000 characters                                      |
| `notes`              | Optional, up to 2,000 characters; defaults to empty text          |
| `dailyDouble`        | Optional boolean; defaults to false; exactly one must be true     |
| `final.category`     | Required, 1–100 characters                                        |
| `final.question`     | Required, 1–3,000 characters                                      |
| `final.answer`       | Required, 1–2,000 characters                                      |

Unknown properties, malformed JSON, empty required fields, oversized text, and unbalanced boards are rejected. Use JSON double quotes; comments and trailing commas are not valid JSON. The text input is limited to 600,000 characters. PINs and join codes are not part of this format.

The server validates the import before any replacement. Importing never starts a session or changes an existing live session. Canceling the replacement confirmation leaves the current board intact.

**Use current board JSON** fills the textarea with the current board, including manual edits. Incomplete drafts can be exported this way, but must be completed before re-import validation succeeds. The stored JSON is normalized and automatically synchronized from the saved board, including changes made through the visual editor.

## Optional saved tiebreakers

Add this top-level field alongside `categories` and `final`:

```json
"tiebreakers": [
  {"category": "World capitals", "question": "Which city is the capital of Canada?", "answer": "What is Ottawa?"},
  {"category": "Science", "question": "Which element has the chemical symbol He?", "answer": "What is helium?"}
]
```

The array is optional and may be empty; at most 20 clues are allowed. Category: 1–100 characters; question: 1–3,000; answer: 1–2,000. Unknown fields (including dollar values/wagers), blank strings and oversized entries are rejected. Clues retain array order. The host presents the next saved clue with one click during sudden death. Exhausting the list allows custom entry; saved clues are never repeated automatically. All fields can also be edited/reordered under **Sudden-death tiebreakers** in Create/Edit Game. Older JSON without the field remains valid. Apply `003_saved_tiebreakers.sql` after 002 to update the stored database JSON generator.
