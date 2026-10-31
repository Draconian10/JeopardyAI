-- Run after 001_initial.sql, including on existing installations.
-- Stored generated columns keep portable question JSON consistent with the board
-- for imports, manual edits, duplicates, autosaves, and session snapshots alike.
create function public.board_question_json(p_board jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', p_board->>'title',
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', c.name,
        'questions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'value', q.item->'value',
            'question', q.item->>'prompt',
            'answer', q.item->>'answer',
            'notes', coalesce(q.item->>'notes',''),
            'dailyDouble', coalesce(q.item->'dailyDouble','false'::jsonb)
          ) order by (q.item->>'row')::integer)
          from jsonb_array_elements(p_board->'questions') as q(item)
          where (q.item->>'category')::integer = c.position-1
        ),'[]'::jsonb)
      ) order by c.position)
      from jsonb_array_elements_text(p_board->'categories') with ordinality as c(name,position)
    ),'[]'::jsonb),
    'final', jsonb_build_object(
      'category', p_board->'final'->>'category',
      'question', p_board->'final'->>'prompt',
      'answer', p_board->'final'->>'answer'
    )
  );
$$;
revoke all on function public.board_question_json(jsonb) from public, anon, authenticated;
grant execute on function public.board_question_json(jsonb) to service_role;
alter table public.games add column question_json jsonb
  generated always as (public.board_question_json(board)) stored;
alter table public.sessions add column question_json jsonb
  generated always as (public.board_question_json(state->'board')) stored;
-- PostgreSQL backfills existing rows. Existing RLS/grants protect answers in both
-- new columns; neither is added to any public/player Realtime projection.
