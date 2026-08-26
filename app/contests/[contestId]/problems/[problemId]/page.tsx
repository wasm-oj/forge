import { ManagedProblemWorkspace } from "@/src/features/judge/components/managed-problem-workspace";

export default async function ContestProblemPage({
  params,
}: {
  readonly params: Promise<{
    readonly contestId: string;
    readonly problemId: string;
  }>;
}) {
  const { contestId, problemId } = await params;
  return <ManagedProblemWorkspace contestId={contestId} problemId={problemId} />;
}
