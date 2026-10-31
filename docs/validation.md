# Validation reference

Client checks provide feedback. Every authoritative check runs on the server or in a PostgreSQL constraint/transaction.

| Area               | Rules                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board              | Trimmed title 1–100 chars; 1–8 categories of at most 80 chars; 1–8 rows; exactly one unique question ID/position per cell; integer values 1–100,000; prompt ≤3,000; answer/notes ≤2,000 |
| Launch             | All category names/questions/answers required; exactly one Daily Double; Final category/question/answer required; host owner; valid PIN; archived games blocked                         |
| Drafts             | Incomplete text permitted; board structure must remain valid; optimistic editor version prevents overwrites                                                                             |
| PIN/code           | Exactly six numeric characters; leading zeros preserved; active join codes unique; PINs salted and scrypt-hashed                                                                        |
| Names              | Trimmed, 1–24 chars, printable Unicode, case-insensitive uniqueness among active seats; escaped React text                                                                              |
| Joining            | Active code; lobby open; fewer than 50 total seats; host cannot self-play; removed identities cannot rejoin                                                                             |
| Reconnection       | Existing guest identity restores its seat even after lobby closes; removed identities remain rejected                                                                                   |
| Start              | Controlling host; nonempty lobby; not paused; lobby phase; gameplay version current                                                                                                     |
| Question selection | Controlling host; board phase; unused valid tile; no unresolved question                                                                                                                |
| Buzz               | Player membership; game unpaused; question phase; before server deadline; matching window UUID; player has not missed; CAS grants one winner                                            |
| Judgment           | Host/controller; pending answer; current gameplay version; one application per action ID; atomic outcome/score                                                                          |
| Timer              | Server deadline authoritative; pauses store remaining time; new window after miss; expiry before host-loss pause is resolved first                                                      |
| Daily Double       | Valid active player; integer wager 0…absolute score; wager locks before prompt; buzz disabled                                                                                           |
| Final wagers       | Player's own entry; wagering phase; integer 0…absolute pre-Final score; hidden from other players; missing wagers default to zero only when host opens question                         |
| Final answers      | Own entry; answer phase; unpaused; text ≤2,000 chars; server receipt before deadline; latest saved text retained                                                                        |
| Final review       | Host/controller; ascending pre-Final score order; no repeated judgment; blanks cannot be correct; all judged before finish                                                              |
| Standings          | Server score deltas; negative scores allowed; score arithmetic bounded and integral; ties share victory                                                                                 |
| Resume             | Host account and session PIN; unfinished session; fresh controller; session snapshot retained; explicit Continue                                                                        |
| End                | Host/controller; explicit UI confirmation; terminal phase; further gameplay rejected; history retained                                                                                  |
| API                | Strict schemas; authenticated bearer identity; same-origin browser mutations; UUID identifiers; bounded body; role/membership/controller checks; rate limits                            |
| Database           | RLS and grants block direct private reads and privileged browser RPCs; atomic CAS; unique active codes; member-only notification policy                                                 |
| Privacy            | No full state broadcasts; projections omit private answers/notes/future prompts; audience projection omits host secrets                                                                 |

## Manual deployment acceptance check

Use a configured Supabase project and at least two browser profiles/devices:

1. Create a host account and a board with the starter deck; save and launch it.
2. Join two players, try a duplicate name, lock the lobby, and try a new join.
3. Buzz nearly simultaneously. Verify one respondent on every screen.
4. Mark incorrect; verify the deduction, resumed remaining time, excluded player, and a different player winning.
5. Verify a correct answer, reveal, standings delta, and inactive tile.
6. Close the host tab during a countdown. Wait >15 seconds. Reopen Host Game → Resume → enter PIN → Continue. Verify preserved time, code, players, score, and question.
7. Open another host console; claim it and verify the old console can no longer control or heartbeat.
8. Play the Daily Double with positive, zero, and negative-score wager bounds.
9. Complete the board, save Final wagers, type/revise answers, and confirm answer locking at zero.
10. Judge players in order, announce results, reload, and check historical results.
11. Inspect the player/audience API payloads to confirm no unrevealed answers or other players' private Final data.
