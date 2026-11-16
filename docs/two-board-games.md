# Optional Double Jeopardy and correctable Final review

## Deployment

Apply `supabase/migrations/006_optional_double_jeopardy.sql` in Supabase SQL Editor after migrations 001–005, before deploying this version. This updates the private generated question-JSON function. It adds no tables or public permissions, and does not change scores, phase, controller or session versions. One-board records remain unchanged. There are no new environment variables.

The migration can be applied while the previous app version is running. Deploy the new app afterward; already-open host/player/audience tabs should refresh together before starting a two-board game. Older clients do not understand the new round-break phase. Existing one-board boards, JSON, ongoing sessions, recovery codes, display links, Resume/Continue, CSV and gameplay rules remain supported.

## One board remains the default

New games and the original JSON example still contain only one board. Without `doubleJeopardy`, the completed board leads directly to Final Jeopardy as before. No player readiness step is introduced.

To add another round in the editor, select **Add Double Jeopardy board**. Switch between **Jeopardy board** and **Double Jeopardy board** to edit them in the same grid/editor. The new second board starts blank with values $400/$800/$1,200/$1,600/$2,000 and two Daily Double positions. It must be completed before launch. Changing the selected board's dimensions or loading its starter content affects only that board; title, Final and saved tiebreakers are shared. Removing Double Jeopardy requires confirmation and keeps the first board.

Each board supports 1–8 categories and 1–8 rows, independently. The second board needs at least two clues to hold its two Daily Doubles. Custom clue values are allowed; doubled values are defaults, not mandatory validation. Existing Daily Double/Final wager rules remain $0 through absolute score. Adding the round does not silently switch the game to television wager or eligibility rules.

## Portable JSON

Keep the existing top-level `title`, `categories`, `final`, and optional `tiebreakers`. Add the optional key below for a two-board game:

```json
{
  "doubleJeopardy": {
    "categories": [
      {
        "name": "Double Science",
        "questions": [
          { "value": 400, "question": "Clue one", "answer": "Response one", "dailyDouble": true },
          { "value": 800, "question": "Clue two", "answer": "Response two", "dailyDouble": true }
        ]
      }
    ]
  }
}
```

This snippet is an addition to a complete existing game, not a standalone import. See `examples/two-board-import.json` for a complete importable example. Omit `doubleJeopardy` for one board; do not supply null or an empty object. The shared Final appears once at the top level, after both rounds in play.

Validation requires a rectangle and unique nonblank category names within each imported board, complete clues/responses, bounded values/text, exactly one Daily Double on the first board and exactly two on the second. Category names may repeat between rounds. Internal clue UUIDs are regenerated independently on import and must be unique across both boards on saves. Total imported text remains limited to 600,000 characters; normal request/local-recovery size limits still apply. Saved generated JSON includes both frozen session boards after migration 006.

## Round transition

Completing the last clue on the first board and choosing **Round standings** enters a durable standings break. All views show the scores; only the controlling host can select **Start Double Jeopardy**. Scores, score history, membership, join code and session ID carry over. The lowest-scoring active player selects first; an equal-score tie uses stable player-ID ordering. The host continues clicking tiles. Correct responses then transfer selection as usual, including Daily Doubles.

The second board uses the existing tile/clue/buzzer/response/undo layouts. First-round tiles cannot be selected again. The new round and the break survive host closure, takeover and Resume/Continue. Only completing the second board starts Final wagering, using the scores at that point. No unrevealed second-board clue or response is sent to players or audience.

## Correct Final judgments

During **Final review**, the controlling host can open **Correct a Final judgment** for any already-judged response, including after all responses are judged. Confirm changing it to correct/incorrect. Blank responses cannot be marked correct. Original response text, wager, pre-Final score and review order stay unchanged.

Each correction applies only the difference between the old and new wager outcome (for example, changing a $200 loss to a $200 win adds $400). Corrections may be repeated; zero wagers change correctness without changing money. Scores and standings update immediately. The event ledger and CSV record each actual adjustment, and replayed/stale commands cannot apply the same adjustment twice.

**Announce the winner** or **Start sudden-death tiebreaker** confirms the results and locks Final judgments. The server computes the highest score and tied leaders from the corrected totals at this confirmation. Corrections are rejected once a tiebreaker has started or results have been announced. A host takeover during review preserves every accepted judgment/correction.
