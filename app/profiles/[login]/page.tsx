import { ProfileView } from "@/src/features/profiles/components/profile-view";

export default async function ProfilePage({ params }: { readonly params: Promise<{ readonly login: string }> }) {
  const { login } = await params;
  return <ProfileView login={login} />;
}
