import { ManagedProblemWorkspace } from "@/src/components/managed-problem-workspace";

export default async function ContestProblemPage({
  params,
}: {
  readonly params: Promise<{
    readonly contestId: string;
    readonly problemVersionId: string;
  }>;
}) {
  const { contestId, problemVersionId } = await params;
  return <ManagedProblemWorkspace contestId={contestId} problemVersionId={problemVersionId} />;
}
