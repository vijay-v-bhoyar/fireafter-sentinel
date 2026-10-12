import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function RecoverPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; submitted?: string }>;
}) {
  const params = await searchParams;
  const submitted = params.submitted === "1";

  return (
    <main className="grid min-h-screen place-items-center bg-[#06111c] px-4 py-10 text-slate-100">
      <section className="w-full max-w-md rounded-md border border-slate-700 bg-[#0b1d2d] p-6 shadow-2xl">
        <p className="text-sm font-semibold text-orange-400">FIREAFTER</p>
        <h1 className="mt-2 text-2xl font-bold">Recover your account</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300">
          Enter the email for your operator-issued account. If it is eligible, we will send a recovery link.
        </p>

        {submitted && (
          <p className="mt-5 rounded-md border border-emerald-400/40 bg-emerald-950/40 p-3 text-sm text-emerald-100">
            Check your email for a recovery link. The result is the same whether or not an account is issued for this address.
          </p>
        )}
        {params.error && (
          <p className="mt-5 rounded-md border border-red-400/40 bg-red-950/50 p-3 text-sm text-red-100">
            {params.error}
          </p>
        )}

        <form action="/api/auth/password/recovery" method="post" className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm text-slate-300">Email</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-2 h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
            />
          </label>
          <button className="h-11 w-full rounded-md bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500">
            Send recovery link
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-slate-400">
          <Link href="/login" className="text-sky-300 hover:text-sky-200">Return to sign in</Link>
        </p>
      </section>
    </main>
  );
}
