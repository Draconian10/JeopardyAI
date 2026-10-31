import type { Board } from './schema';
export type Phase =
  | 'lobby'
  | 'practiceReady'
  | 'practiceOpen'
  | 'practiceAnswer'
  | 'board'
  | 'question'
  | 'answering'
  | 'dailyWager'
  | 'dailyAnswer'
  | 'reveal'
  | 'finalWager'
  | 'finalAnswer'
  | 'finalReview'
  | 'finished'
  | 'ended';
export interface Player {
  id: string;
  name: string;
  score: number;
  lastSeen: number;
  removed: boolean;
}
export interface ScoreEvent {
  questionId: string;
  id: string;
  playerId: string;
  delta: number;
  reason: string;
  at: number;
}
export interface FinalEntry {
  score: number;
  wager?: number;
  text: string;
  judged?: boolean;
  correct?: boolean;
}
export interface Session {
  id: string;
  gameId: string;
  hostId: string;
  joinCode: string;
  title: string;
  board: Board;
  version: number;
  actionVersion: number;
  phase: Phase;
  paused: boolean;
  pauseReason?: string;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  controller?: string;
  hostSeen: number;
  players: Player[];
  used: string[];
  questionId?: string;
  windowId?: string;
  deadline?: number;
  answerLimitSeconds?: number;
  answerDeadline?: number;
  answerRemaining?: number;
  lastTimeout?: { playerId: string; at: number };
  questionOpenedAt?: number;
  remaining: number;
  respondent?: string;
  attempted: string[];
  daily?: { playerId: string; amount: number };
  final: Record<string, FinalEntry>;
  events: ScoreEvent[];
  history: { actionId: string; type: string; userId: string; at: number; phase: Phase }[];
  processed: string[];
  undo?: {
    phase: Phase;
    respondent?: string;
    attempted: string[];
    remaining: number;
    used: string[];
    eventsLength: number;
    scores: Record<string, number>;
    windowId?: string;
    daily?: { playerId: string; amount: number };
  };
}
export interface Context {
  userId: string;
  now: number;
  controller?: string;
  actionId: string;
  expectedVersion: number;
  pinVerified?: boolean;
  dashboardEnd?: boolean;
}
export interface SessionView {
  id: string;
  gameId: string;
  title: string;
  joinCode: string;
  version: number;
  actionVersion: number;
  phase: Phase;
  paused: boolean;
  pauseReason?: string;
  locked: boolean;
  createdAt: number;
  serverNow: number;
  hostConnected: boolean;
  controllerOwned: boolean;
  players: Player[];
  categories: string[];
  rows: number;
  tiles: { id: string; category: number; row: number; value: number; used: boolean }[];
  question?: {
    id: string;
    prompt: string;
    value: number;
    category: string;
    answer?: string;
    notes?: string;
  };
  finalCategory?: string;
  finalPrompt?: string;
  finalAnswer?: string;
  finalEntries: Record<string, Partial<FinalEntry>>;
  finalReviewPlayer?: string;
  remaining: number;
  questionOpenedAt?: number;
  deadline?: number;
  answerLimitSeconds?: number;
  answerDeadline?: number;
  answerRemaining?: number;
  lastTimeout?: { playerId: string; at: number };
  windowId?: string;
  respondent?: string;
  attempted: string[];
  daily?: { playerId: string; amount: number };
  events: ScoreEvent[];
  canUndo: boolean;
}
