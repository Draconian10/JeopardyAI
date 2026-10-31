import { NextRequest, NextResponse } from 'next/server';
import { randomInt } from 'node:crypto';
import { playerSessionSummary } from '@/lib/game/player-sessions';
import type { Session } from '@/lib/game/types';
import { parseQuestionJson, MAX_QUESTION_JSON_LENGTH } from '@/lib/game/question-json';
import { z } from 'zod';
import { db, hashPin, verifyPin, identity, hostOnly, limit } from '@/lib/server/db';
import { loadSession, mutate, readSession } from '@/lib/server/sessions';
import { createSession, GameError, viewSession } from '@/lib/game/engine';
import { envelopeSchema, pinSchema, playable, saveSchema, type Board } from '@/lib/game/schema';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const uuid = z.string().uuid();
async function json(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 1500000) throw new GameError('Request is too large.', 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw new GameError('Invalid JSON.');
  }
}
async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    if (req.method !== 'GET') {
      const origin = req.headers.get('origin');
      if (origin && origin !== req.nextUrl.origin)
        throw new GameError('Cross-origin request rejected.', 403);
    }
    const user = await identity(req);
    const { path } = await ctx.params;
    const [resource, id, op] = path;
    if (path.length > 3) throw new GameError('Route not found.', 404);
    const database = db();
    if (resource === 'player-sessions' && req.method === 'GET' && !id) {
      const { data: memberships, error: membershipError } = await database
        .from('session_members')
        .select('session_id')
        .eq('user_id', user.id);
      if (membershipError) throw new GameError('Could not load your active games.', 503);
      if (!memberships.length) return NextResponse.json({ sessions: [] });
      const { data: rows, error } = await database
        .from('sessions')
        .select('state')
        .in(
          'id',
          memberships.map((m) => m.session_id),
        )
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw new GameError('Could not load your active games.', 503);
      return NextResponse.json({
        sessions: rows.flatMap((row) => {
          const summary = playerSessionSummary(row.state as Session, user.id);
          return summary ? [summary] : [];
        }),
      });
    }
    if (resource === 'games') {
      hostOnly(user);
      if (req.method === 'GET' && !id) {
        const [games, sessions] = await Promise.all([
          database
            .from('games')
            .select('id,board,version,updated_at,archived')
            .eq('owner_id', user.id)
            .order('updated_at', { ascending: false }),
          database
            .from('sessions')
            .select('id,game_id,join_code,active,state,created_at')
            .eq('host_id', user.id)
            .order('created_at', { ascending: false }),
        ]);
        if (games.error || sessions.error) throw new GameError('Could not load games.', 503);
        return NextResponse.json({
          games: games.data.map((g) => ({
            id: g.id,
            title: (g.board as Board).title,
            version: g.version,
            updatedAt: g.updated_at,
            archived: g.archived,
          })),
          sessions: sessions.data.map((s) => ({
            id: s.id,
            gameId: s.game_id,
            joinCode: s.join_code,
            active: s.active,
            phase: s.state.phase,
            players: s.state.players.filter((p: { removed: boolean }) => !p.removed).length,
            createdAt: s.created_at,
          })),
        });
      }
      if (req.method === 'POST' && !id) {
        await limit(req, user.id, 'save', 20);
        const body = saveSchema.parse(await json(req));
        if (!body.pin) throw new GameError('Set a six-digit host PIN.');
        const { data, error } = await database
          .from('games')
          .insert({ owner_id: user.id, board: body.board, pin_hash: hashPin(body.pin) })
          .select('id')
          .single();
        if (error) throw new GameError('Could not create game.', 503);
        return NextResponse.json(data, { status: 201 });
      }
      if (req.method === 'POST' && id === 'import' && !op) {
        await limit(req, user.id, 'save', 30);
        const body = z
          .object({ text: z.string().max(MAX_QUESTION_JSON_LENGTH) })
          .strict()
          .parse(await json(req));
        try {
          return NextResponse.json({ board: parseQuestionJson(body.text) });
        } catch (error) {
          if (error instanceof z.ZodError) throw error;
          throw new GameError((error as Error).message);
        }
      }
      uuid.parse(id);
      const { data: game, error } = await database
        .from('games')
        .select('*')
        .eq('id', id)
        .eq('owner_id', user.id)
        .single();
      if (error || !game) throw new GameError('Game not found.', 404);
      if (req.method === 'GET' && !op)
        return NextResponse.json({
          id: game.id,
          board: game.board,
          version: game.version,
          questionJson: game.question_json,
        });
      if (req.method === 'PUT' && !op) {
        await limit(req, user.id, 'save', 30);
        const body = saveSchema.parse(await json(req));
        if (body.version === undefined) throw new GameError('Game version is required.');
        const { data, error } = await database
          .from('games')
          .update({
            board: body.board,
            ...(body.pin ? { pin_hash: hashPin(body.pin) } : {}),
            version: body.version + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('owner_id', user.id)
          .eq('version', body.version)
          .select('id,version')
          .maybeSingle();
        if (error) throw new GameError('Could not save game.', 503);
        if (!data)
          throw new GameError('This game was edited elsewhere. Reload before saving.', 409);
        return NextResponse.json(data);
      }
      if (req.method === 'POST' && op === 'archive') {
        await limit(req, user.id, 'save', 30);

        const body = z
          .object({ archived: z.boolean(), version: z.number().int().min(0) })
          .strict()
          .parse(await json(req));
        if (body.archived) {
          const { data: active, error: checkError } = await database
            .from('sessions')
            .select('id')
            .eq('game_id', id)
            .eq('active', true)
            .limit(1);
          if (checkError) throw new GameError('Could not check running sessions.', 503);
          if (active?.length)
            throw new GameError(
              'Finish or explicitly end this board’s active sessions before archiving.',
              409,
            );
        }
        const { data, error } = await database
          .from('games')
          .update({ archived: body.archived, version: body.version + 1 })
          .eq('id', id)
          .eq('owner_id', user.id)
          .eq('version', body.version)
          .select('id')
          .maybeSingle();
        if (error) throw new GameError('Could not archive game.', 503);
        if (!data) throw new GameError('Game changed. Reload first.', 409);
        return NextResponse.json(data);
      }
      if (req.method === 'POST' && op === 'start') {
        if (game.archived) throw new GameError('Restore this board before starting it.');
        await limit(req, user.id, 'pin', 10, 60);
        const body = z
          .object({ pin: pinSchema, separate: z.boolean().default(false), requestId: uuid })
          .strict()
          .parse(await json(req));
        if (!verifyPin(body.pin, game.pin_hash)) throw new GameError('Incorrect host PIN.', 403);
        try {
          playable(game.board);
        } catch (e) {
          throw new GameError((e as Error).message);
        }
        const { data: existing } = await database
          .from('sessions')
          .select('id,state')
          .eq('id', body.requestId)
          .eq('host_id', user.id)
          .maybeSingle();
        if (existing) return NextResponse.json({ id: existing.id });
        const { data: running, error: runningError } = await database
          .from('sessions')
          .select('id')
          .eq('game_id', id)
          .eq('active', true);
        if (runningError) throw new GameError('Could not check running sessions.', 503);
        if (running?.length && !body.separate)
          throw new GameError(
            'An unfinished session exists. Resume it or explicitly start a separate session.',
            409,
          );
        for (let i = 0; i < 15; i++) {
          const s = createSession(
            game.board,
            id,
            user.id,
            String(randomInt(0, 1000000)).padStart(6, '0'),
            Date.now(),
          );
          s.id = body.requestId;
          const { error } = await database.rpc('launch_session', {
            p_state: s,
            p_pin_hash: game.pin_hash,
            p_separate: body.separate,
          });
          if (!error) {
            // Launch inserts the host membership in the same transaction.
            return NextResponse.json({ id: s.id }, { status: 201 });
          }
          if (error.code === 'P0001') throw new GameError(error.message, 409);
          if (error.code !== '23505') throw new GameError('Could not start session.', 503);
          const { data: retry } = await database
            .from('sessions')
            .select('id')
            .eq('id', body.requestId)
            .eq('host_id', user.id)
            .maybeSingle();
          if (retry) return NextResponse.json({ id: retry.id });
        }
        throw new GameError('Could not allocate a join code. Please retry.', 503);
      }
    }
    if (resource === 'join' && req.method === 'POST' && !id) {
      await limit(req, user.id, 'join', 20, 60);
      const body = z
        .object({
          code: pinSchema,
          name: z
            .string()
            .trim()
            .min(1)
            .max(24)
            .refine((s) => !/[\p{C}]/u.test(s), 'Use a printable name.'),
        })
        .strict()
        .parse(await json(req));
      const { data, error } = await database
        .from('sessions')
        .select('id')
        .eq('join_code', body.code)
        .eq('active', true)
        .maybeSingle();
      if (error || !data) throw new GameError('No active game matches that code.', 404);
      await mutate(
        data.id,
        { type: 'join', name: body.name },
        { userId: user.id, now: Date.now(), actionId: crypto.randomUUID(), expectedVersion: 0 },
      );
      return NextResponse.json({ id: data.id });
    }
    if (resource === 'sessions') {
      uuid.parse(id);
      const controller = req.headers.get('x-controller') ?? undefined;
      if (controller) uuid.parse(controller);
      if (req.method === 'GET' && !op) {
        const { state } = await loadSession(id, user.id);
        return NextResponse.json(
          viewSession(
            state,
            user.id,
            Date.now(),
            controller,
            req.nextUrl.searchParams.get('view') === 'audience',
          ),
        );
      }
      if (req.method === 'POST' && op === 'end') {
        hostOnly(user);
        await limit(req, user.id, 'commands', 60, 60);
        const body = z
          .object({ actionId: uuid, confirmed: z.literal(true) })
          .strict()
          .parse(await json(req));
        const row = await readSession(id);
        if (row.state.hostId !== user.id)
          throw new GameError('Only the host can end this session.', 403);
        await mutate(
          id,
          { type: 'end' },
          {
            userId: user.id,
            now: Date.now(),
            actionId: body.actionId,
            expectedVersion: row.state.actionVersion,
            dashboardEnd: true,
          },
        );
        return NextResponse.json({ id, ended: true });
      }
      if (req.method === 'POST' && op === 'command') {
        const body = envelopeSchema.parse(await json(req));
        let verified = false;
        if (body.command.type === 'claim') {
          await limit(req, user.id, 'pin', 10, 60);
          const row = await readSession(id);
          if (row.state.hostId !== user.id) throw new GameError('Only the host can resume.', 403);
          verified = verifyPin(body.command.pin, row.pin_hash);
        } else if (body.command.type === 'heartbeat')
          await limit(req, user.id, 'heartbeat', 30, 60);
        else if (body.command.type === 'tick') await limit(req, user.id, 'tick', 60, 60);
        else if (body.command.type === 'answer') await limit(req, user.id, 'answers', 240, 60);
        else await limit(req, user.id, 'commands', 240, 60);
        const state = await mutate(id, body.command, {
          userId: user.id,
          now: Date.now(),
          controller: body.controller,
          actionId: body.actionId,
          expectedVersion: body.version,
          pinVerified: verified,
        });
        return NextResponse.json(viewSession(state, user.id, Date.now(), body.controller));
      }
    }
    throw new GameError('Route not found.', 404);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join('.') || 'JSON'}: ${i.message}`).join(' ')
        : error instanceof GameError
          ? error.message
          : error instanceof Error && error.message.startsWith('Complete')
            ? error.message
            : 'Something went wrong. Please try again.';
    const status =
      error instanceof GameError ? error.status : error instanceof z.ZodError ? 400 : 400;
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const r = await handle(req, ctx);
  r.headers.set('Cache-Control', 'no-store');
  return r;
}
export const POST = GET;
export const PUT = GET;
