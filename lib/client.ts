'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
let instance: SupabaseClient | undefined;
export function configured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}
export function supabase() {
  if (!configured()) throw new Error('Add the Supabase environment variables to get started.');
  instance ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return instance;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  controller?: string,
  timeoutMs = 30000,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = () => new ApiError('Connection timed out. Reconnecting…', 503);
  const request = async () => {
    const { data } = await supabase().auth.getSession();
    if (abort.signal.aborted) throw expired();
    if (!data.session) throw new ApiError('Sign in or join the game first.', 401);
    const response = await fetch(`/api/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.session.access_token}`,
        ...(controller ? { 'x-controller': controller } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: abort.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.error ?? 'Request failed.', response.status);
    return result as T;
  };
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(expired());
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (abort.signal.aborted) throw expired();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
