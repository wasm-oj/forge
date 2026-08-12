import { ContestOverview } from "@/src/features/contests/components/contest-overview";

export default async function ContestPage({ params }: { readonly params: Promise<{ readonly contestId: string }> }) {
  const { contestId } = await params;
  return <ContestOverview contestId={contestId} />;
}
