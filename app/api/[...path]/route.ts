import { NextRequest, NextResponse } from 'next/server';
import { randomInt } from 'node:crypto';
import { guestSecret, guestSecretHash, secretMatches } from '@/lib/server/guest-access';
import { playerSessionSummary } from '@/lib/game/player-sessions';
import { resultsCsv } from '@/lib/game/results-csv';
import type { Session } from '@/lib/game/types';
import { parseQuestionJson, MAX_QUESTION_JSON_LENGTH } from '@/lib/game/question-json';
import { z } from 'zod';
import { db, hashPin, verifyPin, identity, hostOnly, limit } from '@/lib/server/db';
import { heartbeat, saveAnswer, loadSession, mutate, readSession } from '@/lib/server/sessions';
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
    const { path } = await ctx.params;
    const [resource, id, op] = path;
    if (path.length > 3) throw new GameError('Route not found.', 404);
    // Audience links are scoped read-only bearer capabilities, not Supabase identities.
    if (resource === 'display' && req.method === 'GET' && id && !op) {
      uuid.parse(id);
      const token = req.nextUrl.searchParams.get('token') ?? '';
      if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new GameError('Display link is invalid.', 403);
      await limit(req, id, 'display-read', 600, 60);
      const { data: link, error } = await db()
        .from('session_display_links')
        .select('token_hash')
        .eq('session_id', id)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (error) throw new GameError('Could not validate the display link.', 503);
      if (!link || !secretMatches(link.token_hash, guestSecretHash('display', id, token)))
        throw new GameError('Display link has expired or was replaced.', 403);
      const { state, runtimeAt } = await readSession(id);
      return NextResponse.json({
        ...viewSession(state, state.hostId, Date.now(), undefined, true),
        controllerOwned: false,
        runtimeAt,
      });
    }
    const user = await identity(req);
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
    if (resource === 'recovery' && id === 'request' && req.method === 'POST' && !op) {
      await limit(req, user.id, 'recovery-request', 30, 60);
      if (!user.is_anonymous)
        throw new GameError('Recover a seat from a separate anonymous player session.', 403);
      const body = z
        .object({ code: pinSchema, recoveryCode: z.string().regex(/^[A-Za-z0-9_-]{24}$/) })
        .strict()
        .parse(await json(req));
      const { data: room, error: roomError } = await database
        .from('sessions')
        .select('id,state')
        .eq('join_code', body.code)
        .eq('active', true)
        .maybeSingle();
      if (roomError) throw new GameError('Could not locate the game.', 503);
      if (!room) throw new GameError('Game or recovery code not found.', 404);
      const game = room.state as Session;
      if (game.hostId === user.id || game.players.some((p) => p.id === user.id))
        throw new GameError('This identity already belongs to the game.', 409);
      const { data: codes, error } = await database
        .from('session_player_recovery_codes')
        .select('player_id,code_hash,expires_at')
        .eq('session_id', room.id);
      if (error) throw new GameError('Could not check the recovery code.', 503);
      const hash = guestSecretHash('recovery', room.id, body.recoveryCode);
      const found = codes.find(
        (entry) =>
          new Date(entry.expires_at).getTime() > Date.now() &&
          secretMatches(entry.code_hash, hash) &&
          game.players.some((p) => p.id === entry.player_id && !p.removed),
      );
      if (!found) throw new GameError('Game or recovery code not found.', 404);
      const { data: request, error: requestError } = await database
        .from('session_player_recovery_requests')
        .insert({
          session_id: room.id,
          player_id: found.player_id,
          claimant_id: user.id,
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
        .select('id')
        .single();
      if (requestError) throw new GameError('Could not request recovery.', 503);
      return NextResponse.json({ requestId: request.id }, { status: 201 });
    }
    if (resource === 'recovery' && id && req.method === 'GET' && !op) {
      uuid.parse(id);
      const { data: request, error } = await database
        .from('session_player_recovery_requests')
        .select('status,session_id,expires_at')
        .eq('id', id)
        .eq('claimant_id', user.id)
        .maybeSingle();
      if (error) throw new GameError('Could not check recovery status.', 503);
      if (!request) throw new GameError('Recovery request not found.', 404);
      const status =
        request.status === 'pending' && new Date(request.expires_at).getTime() < Date.now()
          ? 'expired'
          : request.status;
      return NextResponse.json({
        status,
        ...(status === 'approved' ? { sessionId: request.session_id } : {}),
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
            title: s.state.title ?? s.state.board?.title ?? 'Game',
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
          .object({
            pin: pinSchema,
            separate: z.boolean().default(false),
            requestId: uuid,
            controller: uuid.optional(),
          })
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
            body.controller,
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
      if (req.method === 'POST' && op === 'recovery-code') {
        await limit(req, user.id, 'recovery-code', 60, 60);
        const { state } = await readSession(id);
        if (['ended', 'finished'].includes(state.phase))
          throw new GameError('This game has ended.', 409);
        if (!state.players.some((p) => p.id === user.id && !p.removed))
          throw new GameError('Only a joined player can create a recovery code.', 403);
        const code = guestSecret(18);
        const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
        const { error } = await database.from('session_player_recovery_codes').upsert(
          {
            session_id: id,
            player_id: user.id,
            code_hash: guestSecretHash('recovery', id, code),
            expires_at: expiresAt,
          },
          { onConflict: 'session_id,player_id' },
        );
        if (error) throw new GameError('Could not create a recovery code.', 503);
        return NextResponse.json({ code, expiresAt });
      }
      if (req.method === 'POST' && op === 'display-link') {
        hostOnly(user);
        await limit(req, user.id, 'display-link', 60, 60);
        const { state } = await readSession(id);
        if (state.hostId !== user.id)
          throw new GameError('Only the host can share a display.', 403);
        const token = guestSecret(24);
        const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
        const { error } = await database.from('session_display_links').upsert(
          {
            session_id: id,
            token_hash: guestSecretHash('display', id, token),
            expires_at: expiresAt,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'session_id' },
        );
        if (error) throw new GameError('Could not create the display link.', 503);
        return NextResponse.json({ token, expiresAt });
      }
      if (req.method === 'GET' && op === 'recovery-requests') {
        hostOnly(user);
        const { state } = await readSession(id);
        if (state.hostId !== user.id)
          throw new GameError('Only the host can review requests.', 403);
        const { data: rows, error } = await database
          .from('session_player_recovery_requests')
          .select('id,player_id,requested_at,expires_at')
          .eq('session_id', id)
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString())
          .order('requested_at', { ascending: true })
          .limit(50);
        if (error) throw new GameError('Could not load recovery requests.', 503);
        return NextResponse.json({
          requests: rows.flatMap((r) => {
            const player = state.players.find((p) => p.id === r.player_id && !p.removed);
            return player ? [{ id: r.id, name: player.name, requestedAt: r.requested_at }] : [];
          }),
        });
      }
      if (req.method === 'POST' && (op === 'recovery-approve' || op === 'recovery-reject')) {
        hostOnly(user);
        await limit(req, user.id, 'recovery-review', 120, 60);
        const body = z
          .object({ requestId: uuid })
          .strict()
          .parse(await json(req));
        const { state } = await readSession(id);
        if (state.hostId !== user.id)
          throw new GameError('Only the host can review requests.', 403);
        if (op === 'recovery-reject') {
          const { error } = await database
            .from('session_player_recovery_requests')
            .update({ status: 'rejected', resolved_at: new Date().toISOString() })
            .eq('session_id', id)
            .eq('id', body.requestId)
            .eq('status', 'pending')
            .gt('expires_at', new Date().toISOString());
          if (error) throw new GameError('Could not decline recovery.', 503);
          return NextResponse.json({ rejected: true });
        }
        const { data, error } = await database.rpc('approve_player_recovery', {
          p_session: id,
          p_host: user.id,
          p_request: body.requestId,
        });
        if (error) throw new GameError('Could not approve recovery.', 503);
        if (data?.error) throw new GameError(data.error, data.status);
        return NextResponse.json(data);
      }
      if (req.method === 'GET' && op === 'results') {
        hostOnly(user);
        const { state } = await readSession(id);
        if (state.hostId !== user.id)
          throw new GameError('Only the session owner can download results.', 403);
        if (!['finished', 'ended'].includes(state.phase))
          throw new GameError('Finish or end the session before downloading results.', 409);
        return new Response(resultsCsv(state), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="jeopardy-results-${id}.csv"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (req.method === 'GET' && !op) {
        const { state, runtimeAt } = await loadSession(id, user.id);
        return NextResponse.json({
          ...viewSession(
            state,
            user.id,
            Date.now(),
            controller,
            req.nextUrl.searchParams.get('view') === 'audience',
          ),
          runtimeAt,
        });
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
        const context = {
          userId: user.id,
          now: Date.now(),
          controller: body.controller,
          actionId: body.actionId,
          expectedVersion: body.version,
          pinVerified: verified,
        };
        if (body.command.type === 'heartbeat')
          return NextResponse.json(await heartbeat(id, context));
        if (body.command.type === 'answer')
          return NextResponse.json(await saveAnswer(id, body.command, context));
        const state = await mutate(id, body.command, context);
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
