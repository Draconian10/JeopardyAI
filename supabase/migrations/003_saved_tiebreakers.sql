-- Run after 002_question_json.sql. Keeps generated JSON aligned with optional saved clues.
begin;
create or replace function public.board_question_json(p_board jsonb)
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
  ) || case when p_board ? 'tiebreakers' then jsonb_build_object(
    'tiebreakers', coalesce((
      select jsonb_agg(jsonb_build_object('category', clue->>'category', 'question', clue->>'prompt', 'answer', clue->>'answer') order by position)
      from jsonb_array_elements(p_board->'tiebreakers') with ordinality as t(clue,position)
    ), '[]'::jsonb)
  ) else '{}'::jsonb end;
$$;
revoke all on function public.board_question_json(jsonb) from public, anon, authenticated;
grant execute on function public.board_question_json(jsonb) to service_role;

-- Recompute stored generated values without changing gameplay or session versions.
update public.games set board = board;
update public.sessions set state = state;
commit;
