/** The email confirmation must return to a publicly accessible host page. */
export function hostConfirmationRedirect(origin: string, publicSiteUrl?: string): string {
  const redirect = new URL('/host', publicSiteUrl?.trim() || origin);
  redirect.searchParams.set('confirmed', '1');
  return redirect.toString();
}

/** A signed-in host cannot also occupy a player seat in their own game. */
export function isHostPlayerConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Use a separate device or browser profile to play.'
  );
}
