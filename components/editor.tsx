'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Sparkles, Star, Check, Eye } from 'lucide-react';
import { HostAuth } from './auth';
import { api, money } from '@/lib/client';
import { boardSchema, playable, type Board } from '@/lib/game/schema';
import { blankBoard, starterBoard } from '@/lib/game/starter';
import {
  boardToQuestionJson,
  MAX_QUESTION_JSON_LENGTH,
  QUESTION_JSON_EXAMPLE,
} from '@/lib/game/question-json';
export default function Editor({ id }: { id: string }) {
  return <HostAuth>{() => <EditorInner id={id} />}</HostAuth>;
}
function EditorInner({ id }: { id: string }) {
  const [board, setBoard] = useState<Board>();
  const [selected, setSelected] = useState<string>('final');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [importError, setImportError] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoBlocked = useRef(false);
  const version = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const latest = useRef<Board | undefined>(undefined);
  const router = useRouter();
  useEffect(() => {
    if (id === 'new') {
      const b = blankBoard();
      setBoard(b);
      latest.current = b;
      return;
    }
    api<{ board: Board; version: number }>(`games/${id}`)
      .then((data) => {
        setBoard(data.board);
        latest.current = data.board;
        version.current = data.version;
        setSelected(data.board.questions[0].id);
      })
      .catch((e) => setError(e.message));
  }, [id]);
  const edit = (next: Board) => {
    setBoard(next);
    latest.current = next;
    dirty.current = true;
    setStatus(id === 'new' ? 'Unsaved draft' : 'Unsaved changes');
  };
  useEffect(() => {
    if (!board || id === 'new' || !dirty.current || autoBlocked.current) return;
    const timer = setTimeout(async () => {
      if (saving.current) return;
      saving.current = true;
      const snapshot = latest.current!;
      setStatus('Saving…');
      try {
        const data = await api<{ version: number }>(`games/${id}`, 'PUT', {
          board: snapshot,
          version: version.current,
        });
        version.current = data.version;
        if (latest.current === snapshot) {
          dirty.current = false;
          setStatus('All changes saved');
        } else setStatus('Unsaved changes');
      } catch (e) {
        autoBlocked.current = true;
        setError((e as Error).message);
        setStatus('Not saved — use Save to retry');
      } finally {
        saving.current = false;
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [board, id, status]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function save() {
    if (!board) return;
    if (saving.current) {
      setError('Autosave is in progress. Please wait a moment.');
      return;
    }
    setBusy(true);
    saving.current = true;
    setError('');
    const snapshot = board;
    try {
      boardSchema.parse(snapshot);
      if (id === 'new') {
        const result = await api<{ id: string }>('games', 'POST', { board: snapshot, pin });
        dirty.current = false;
        router.replace(`/host/edit/${result.id}`);
      } else {
        const result = await api<{ version: number }>(`games/${id}`, 'PUT', {
          board: snapshot,
          pin: pin || undefined,
          version: version.current,
        });
        version.current = result.version;
        if (latest.current === snapshot) dirty.current = false;
        autoBlocked.current = false;
        setPin('');
        setStatus('All changes saved');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      saving.current = false;
    }
  }
  if (!board)
    return (
      <div className="container">
        <p className="error">{error}</p>
        <div className="loading">Opening your board…</div>
      </div>
    );
  const q = board.questions.find((q) => q.id === selected);
  let ready = true;
  try {
    playable(board);
  } catch {
    ready = false;
  }
  return (
    <div className="container editor-container">
      <Link className="back-link" href="/host">
        <ArrowLeft size={16} /> Your boards
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">BUILD SOMETHING BRILLIANT</span>
          <h1>The board is yours.</h1>
          <p className="muted">
            Choose a tile to write its question. Make one a little more interesting.
          </p>
        </div>
        <div className="button-row">
          <button className="button secondary" onClick={() => setPreview(!preview)}>
            <Eye size={16} />
            {preview ? 'Edit board' : 'Preview'}
          </button>
          <button className="button primary" disabled={busy} onClick={() => void save()}>
            <Save size={16} />
            {busy ? 'Saving…' : 'Save game'}
          </button>
        </div>
      </div>
      <p className="error" role="alert">
        {error}
      </p>
      <section className="panel json-import-panel">
        <div className="section-line">
          <div>
            <h2>Create your board from JSON</h2>
            <p className="muted small">
              Paste questions grouped by category to fill the entire board at once.
            </p>
          </div>
          <button
            type="button"
            className="button secondary"
            aria-expanded={importOpen}
            aria-controls="question-json-import"
            onClick={() => {
              setImportOpen(!importOpen);
              setImportError('');
            }}
          >
            {' '}
            {importOpen ? 'Close JSON editor' : 'Import JSON'}{' '}
          </button>
        </div>
        {importOpen && (
          <div id="question-json-import">
            <p className="muted small">
              Include a title, categories with equally sized questions lists, and Final Jeopardy.
              Each question needs value, question, and answer. Mark exactly one dailyDouble as true.
              Optionally include a tiebreakers list with category, question and answer for each
              clue. Your host PIN is entered separately below.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="text-button"
                disabled={importBusy}
                onClick={() => {
                  setJsonText(QUESTION_JSON_EXAMPLE);
                  setImportError('');
                }}
              >
                Load JSON example
              </button>
              <button
                type="button"
                className="text-button"
                disabled={importBusy}
                onClick={() => {
                  setJsonText(JSON.stringify(boardToQuestionJson(board), null, 2));
                  setImportError('');
                }}
              >
                Use current board JSON
              </button>
            </div>
            <label htmlFor="game-question-json">Game JSON</label>
            <textarea
              id="game-question-json"
              className="json-textarea"
              rows={15}
              maxLength={MAX_QUESTION_JSON_LENGTH}
              spellCheck={false}
              value={jsonText}
              disabled={importBusy}
              onChange={(e) => {
                setJsonText(e.target.value);
                setImportError('');
                setImportNotice('');
              }}
              placeholder={'{ "title": "My game", "categories": [...], "final": {...} }'}
            />
            <p className="error" role="alert">
              {importError}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button primary"
                disabled={busy || importBusy || !jsonText.trim()}
                onClick={async () => {
                  setImportBusy(true);
                  setImportError('');
                  setImportNotice('');
                  try {
                    const result = await api<{ board: Board }>('games/import', 'POST', {
                      text: jsonText,
                    });
                    if (!window.confirm('Replace the current board with these JSON questions?'))
                      return;
                    edit(result.board);
                    setSelected(result.board.questions[0].id);
                    setPreview(false);
                    setJsonText(JSON.stringify(boardToQuestionJson(result.board), null, 2));
                    setImportNotice(
                      `Imported ${result.board.questions.length} questions across ${result.board.categories.length} categories. ${id === 'new' ? 'Set your host PIN and save the game.' : 'Save the game or wait for autosave.'}`,
                    );
                  } catch (error) {
                    setImportError((error as Error).message);
                  } finally {
                    setImportBusy(false);
                  }
                }}
              >
                {importBusy ? 'Validating JSON…' : 'Validate & apply JSON'}
              </button>
              <span className="muted small">
                Applying replaces the board only after validation and confirmation.
              </span>
            </div>
          </div>
        )}
        {importNotice && (
          <p className="positive small" role="status">
            {importNotice}
          </p>
        )}
      </section>
      <div className="editor-meta panel">
        <label className="grow">
          Game title
          <input
            maxLength={100}
            value={board.title}
            onChange={(e) => edit({ ...board, title: e.target.value })}
          />
        </label>
        <label>
          Host PIN {id !== 'new' && <small>(leave blank to keep)</small>}
          <input
            inputMode="numeric"
            type="password"
            pattern="[0-9]{6}"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="6 digits"
            autoComplete="new-password"
          />
        </label>
        <div className="save-state">
          <span className={`badge ${ready ? 'green' : ''}`}>
            {ready ? (
              <>
                <Check size={13} /> READY TO PLAY
              </>
            ) : (
              'DRAFT'
            )}
          </span>
          <small role="status">{status}</small>
        </div>
      </div>
      <div className="editor-toolbar">
        <span className="muted small">
          {board.categories.length} categories · {board.rows} rows ·{' '}
          {board.questions.filter((q) => q.prompt && q.answer).length}/{board.questions.length}{' '}
          complete
        </span>
        <div className="button-row">
          <label className="inline-label">
            Columns
            <select
              value={board.categories.length}
              onChange={(e) => {
                if (!confirm('Changing board size resets the questions. Continue?')) return;
                const cols = Number(e.target.value);
                const next = blankBoard();
                next.title = board.title;
                next.categories = Array.from(
                  { length: cols },
                  (_, i) => board.categories[i] ?? `Category ${i + 1}`,
                );
                next.rows = board.rows;
                next.final = board.final;
                next.tiebreakers = board.tiebreakers;
                next.questions = next.categories.flatMap((_, category) =>
                  Array.from({ length: next.rows }, (_, row) => ({
                    id: crypto.randomUUID(),
                    category,
                    row,
                    value: (row + 1) * 200,
                    prompt: '',
                    answer: '',
                    notes: '',
                    dailyDouble: category === 0 && row === 0,
                  })),
                );
                edit(next);
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="inline-label">
            Rows
            <select
              value={board.rows}
              onChange={(e) => {
                if (!confirm('Changing board size resets the questions. Continue?')) return;
                const rows = Number(e.target.value);
                edit({
                  ...board,
                  rows,
                  questions: board.categories.flatMap((_, category) =>
                    Array.from({ length: rows }, (_, row) => ({
                      id: crypto.randomUUID(),
                      category,
                      row,
                      value: (row + 1) * 200,
                      prompt: '',
                      answer: '',
                      notes: '',
                      dailyDouble: category === 0 && row === 0,
                    })),
                  ),
                });
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="text-button"
            onClick={() => {
              if (confirm('Replace this board with the complete starter game?'))
                edit(starterBoard());
            }}
          >
            <Sparkles size={15} /> Load starter board
          </button>
        </div>
      </div>
      <div className="editor-layout">
        <div>
          <div className="board-scroll">
            <div
              className="jeopardy-board editor-board"
              style={{
                gridTemplateColumns: `repeat(${board.categories.length}, minmax(108px,1fr))`,
              }}
            >
              {board.categories.map((category, i) => (
                <div className="category" key={i}>
                  {preview ? (
                    category
                  ) : (
                    <input
                      aria-label={`Category ${i + 1}`}
                      maxLength={80}
                      value={category}
                      onChange={(e) =>
                        edit({
                          ...board,
                          categories: board.categories.map((c, j) =>
                            j === i ? e.target.value : c,
                          ),
                        })
                      }
                    />
                  )}
                </div>
              ))}
              {Array.from({ length: board.rows }, (_, row) =>
                board.categories.map((_, category) => {
                  const tile = board.questions.find(
                    (q) => q.row === row && q.category === category,
                  )!;
                  return (
                    <button
                      className={`board-tile ${selected === tile.id ? 'selected' : ''} ${tile.prompt && tile.answer ? 'complete' : ''}`}
                      key={tile.id}
                      onClick={() => setSelected(tile.id)}
                    >
                      {money(tile.value)}
                      {tile.dailyDouble && (
                        <Star className="tile-star" size={13} fill="currentColor" />
                      )}
                      {tile.prompt && tile.answer && <Check className="tile-check" size={11} />}
                    </button>
                  );
                }),
              )}
            </div>
          </div>
          <button
            className={`final-editor-card ${selected === 'final' ? 'selected' : ''}`}
            onClick={() => setSelected('final')}
          >
            <Star size={21} />
            <span>
              <b>Final Jeopardy</b>
              <small>{board.final.category || 'One last chance to change everything.'}</small>
            </span>
            <span className="badge">EDIT</span>
          </button>
        </div>
        <section className="panel question-editor">
          <span className="eyebrow">
            {q ? `${board.categories[q.category]} · ${money(q.value)}` : 'THE GRAND FINALE'}
          </span>
          <h2>{q ? 'Make them think.' : 'One final question.'}</h2>
          {q ? (
            <>
              <label>
                Point value
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={q.value}
                  disabled={preview}
                  onChange={(e) =>
                    edit({
                      ...board,
                      questions: board.questions.map((x) =>
                        x.id === q.id ? { ...x, value: Number(e.target.value) } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Question
                <textarea
                  rows={5}
                  maxLength={3000}
                  value={q.prompt}
                  disabled={preview}
                  placeholder="What will you ask?"
                  onChange={(e) =>
                    edit({
                      ...board,
                      questions: board.questions.map((x) =>
                        x.id === q.id ? { ...x, prompt: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Correct answer
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={q.answer}
                  disabled={preview}
                  placeholder="The answer is…"
                  onChange={(e) =>
                    edit({
                      ...board,
                      questions: board.questions.map((x) =>
                        x.id === q.id ? { ...x, answer: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Acceptable answers / host notes
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={q.notes}
                  disabled={preview}
                  onChange={(e) =>
                    edit({
                      ...board,
                      questions: board.questions.map((x) =>
                        x.id === q.id ? { ...x, notes: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label className="checkbox daily-toggle">
                <input
                  type="checkbox"
                  checked={q.dailyDouble}
                  disabled={preview}
                  onChange={(e) =>
                    edit({
                      ...board,
                      questions: board.questions.map((x) => ({
                        ...x,
                        dailyDouble: x.id === q.id ? e.target.checked : false,
                      })),
                    })
                  }
                />
                <Star size={18} /> Make this the Daily Double
              </label>
              <p className="muted small">
                Hidden from players until selected. Exactly one per board.
              </p>
            </>
          ) : (
            <>
              {(['category', 'prompt', 'answer'] as const).map((field) => (
                <label key={field}>
                  {field === 'prompt'
                    ? 'Question'
                    : field === 'answer'
                      ? 'Correct answer'
                      : 'Category'}
                  <textarea
                    rows={field === 'prompt' ? 5 : 2}
                    maxLength={field === 'category' ? 100 : field === 'answer' ? 2000 : 3000}
                    disabled={preview}
                    value={board.final[field]}
                    onChange={(e) =>
                      edit({ ...board, final: { ...board.final, [field]: e.target.value } })
                    }
                  />
                </label>
              ))}
              <p className="muted small">
                Players see the category before wagering. The question stays hidden until wagers
                lock.
              </p>
            </>
          )}
        </section>
      </div>
      <section className="panel saved-tiebreakers">
        <h2>Sudden-death tiebreakers</h2>
        <p>
          Optional backup clues, presented in this order if Final Jeopardy ends in a tie. No dollar
          values. Save up to 20.
        </p>
        {(board.tiebreakers ?? []).map((clue, index) => (
          <fieldset key={index}>
            <legend>Tiebreaker {index + 1}</legend>
            {(['category', 'prompt', 'answer'] as const).map((field) => (
              <label key={field}>
                {field === 'prompt' ? 'Clue' : field === 'answer' ? 'Correct answer' : 'Category'}
                <textarea
                  rows={field === 'prompt' ? 3 : 2}
                  maxLength={field === 'category' ? 100 : field === 'prompt' ? 3000 : 2000}
                  value={clue[field]}
                  disabled={preview}
                  onChange={(e) =>
                    edit({
                      ...board,
                      tiebreakers: board.tiebreakers!.map((q, i) =>
                        i === index ? { ...q, [field]: e.target.value } : q,
                      ),
                    })
                  }
                />
              </label>
            ))}
            <div className="button-row">
              <button
                type="button"
                className="button secondary"
                disabled={preview || index === 0}
                onClick={() => {
                  const clues = [...board.tiebreakers!];
                  [clues[index - 1], clues[index]] = [clues[index], clues[index - 1]];
                  edit({ ...board, tiebreakers: clues });
                }}
              >
                Move up
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={preview || index === board.tiebreakers!.length - 1}
                onClick={() => {
                  const clues = [...board.tiebreakers!];
                  [clues[index + 1], clues[index]] = [clues[index], clues[index + 1]];
                  edit({ ...board, tiebreakers: clues });
                }}
              >
                Move down
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={preview}
                onClick={() => {
                  if (confirm('Remove this saved tiebreaker clue?'))
                    edit({
                      ...board,
                      tiebreakers: board.tiebreakers!.filter((_, i) => i !== index),
                    });
                }}
              >
                Remove clue
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="button secondary"
          disabled={preview || (board.tiebreakers?.length ?? 0) >= 20}
          onClick={() =>
            edit({
              ...board,
              tiebreakers: [...(board.tiebreakers ?? []), { category: '', prompt: '', answer: '' }],
            })
          }
        >
          Add tiebreaker clue
        </button>
      </section>
    </div>
  );
}
