import { CliTurnstileApproval } from "@/src/features/auth/components/cli-turnstile-approval";

export default async function CliTurnstilePage({ searchParams }: { readonly searchParams: Promise<{ readonly requestKey?: string }> }) {
  const { requestKey = "" } = await searchParams;
  return <CliTurnstileApproval requestKey={requestKey} />;
}
