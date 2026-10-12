import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center bg-[#06111c] px-4 py-10 text-slate-100">
      <section className="w-full max-w-md rounded-md border border-slate-700 bg-[#0b1d2d] p-6 shadow-2xl">
        <p className="text-sm font-semibold text-orange-400">FIREAFTER</p>
        <h1 className="mt-2 text-2xl font-bold">Set a new password</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Use at least 12 characters. This page only works from a valid recovery link.
        </p>

        {params.error && (
          <p className="mt-5 rounded-md border border-red-400/40 bg-red-950/50 p-3 text-sm text-red-100">
            {params.error}
          </p>
        )}

        <form action="/api/auth/password/update" method="post" className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm text-slate-300">New password</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
              className="mt-2 h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Confirm new password</span>
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={1024}
              required
              className="mt-2 h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
            />
          </label>
          <button className="h-11 w-full rounded-md bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500">
            Update password
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-slate-400">
          <Link href="/recover" className="text-sky-300 hover:text-sky-200">Request a new recovery link</Link>
        </p>
      </section>
    </main>
  );
}
