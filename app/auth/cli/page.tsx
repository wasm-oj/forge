import { CliAuthApproval } from "@/src/features/auth/components/cli-auth-approval";

export default async function CliAuthPage({ searchParams }: { readonly searchParams: Promise<{ readonly flow?: string }> }) {
  const { flow = "" } = await searchParams;
  return <CliAuthApproval flowId={flow} />;
}
