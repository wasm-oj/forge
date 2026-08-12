import { ManagedProblemWorkspace } from "@/src/features/judge/components/managed-problem-workspace";

export default async function ProblemPage({ params }: { readonly params: Promise<{ readonly problemVersionId: string }> }) {
  const { problemVersionId } = await params;
  return <ManagedProblemWorkspace problemVersionId={problemVersionId} />;
}
