import { LoginForm } from "@/components/login-form";
import { safeInternalPath } from "@/lib/safe-navigation";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; returnTo?: string }>;
}) {
  const params = await searchParams;
  return (
    <LoginForm
      error={params.error}
      notice={params.notice}
      returnTo={safeInternalPath(params.returnTo)}
    />
  );
}
