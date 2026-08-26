import { ManagedProblemWorkspace } from "@/src/features/judge/components/managed-problem-workspace";

export default async function ProblemPage({ params }: { readonly params: Promise<{ readonly problemId: string }> }) {
  const { problemId } = await params;
  return <ManagedProblemWorkspace problemId={problemId} />;
}
