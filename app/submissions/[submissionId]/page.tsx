import { SubmissionDetail } from "@/src/components/student-records";

export default async function SubmissionPage({ params }: { readonly params: Promise<{ readonly submissionId: string }> }) {
  const { submissionId } = await params;
  return <SubmissionDetail submissionId={submissionId} />;
}
