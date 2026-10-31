import GameSession from '@/components/session';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GameSession id={id} role="host" />;
}
