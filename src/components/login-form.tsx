"use client";

import Image from "next/image";
import Link from "next/link";

export function LoginForm({
  error,
  notice,
  returnTo = "/",
}: {
  error?: string;
  notice?: string;
  returnTo?: string;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#06111c] px-4 py-10 text-slate-100">
      <section className="w-full max-w-md rounded-md border border-slate-700 bg-[#0b1d2d] p-6 shadow-2xl">
        <div className="flex items-center gap-4">
          <div className="relative h-14 w-14 overflow-hidden rounded-md bg-white">
            <Image
              src="/brand/fireafter-logo.jpg"
              alt="FireAfter logo"
              fill
              sizes="56px"
              className="object-contain"
              priority
            />
          </div>
          <div>
            <div className="text-2xl font-bold">
              <span className="text-orange-500">FIRE</span>AFTER
            </div>
            <p className="text-sm text-slate-300">Responder workspace login</p>
          </div>
        </div>

        {error && (
          <p className="mt-5 rounded-md border border-red-400/40 bg-red-950/50 p-3 text-sm text-red-100">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-5 rounded-md border border-emerald-400/40 bg-emerald-950/40 p-3 text-sm text-emerald-100">
            {notice}
          </p>
        )}

        <section className="mt-5 rounded-md border border-amber-400/30 bg-amber-950/30 p-4 text-sm text-amber-50">
          <p className="font-semibold text-amber-100">Private responder access</p>
          <p className="mt-1 text-amber-100/80">
            Reviewer and responder accounts must be issued by an operator. Public
            visitors can inspect the read-only dashboard without credentials.
          </p>
        </section>

        <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label className="block">
            <span className="text-sm text-slate-300">Email</span>
            <input
              suppressHydrationWarning
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-2 h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-300">Password</span>
            <input
              suppressHydrationWarning
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-2 h-11 w-full rounded-md border border-slate-700 bg-slate-950 px-3 text-sm outline-none ring-sky-400/40 focus:ring-2"
            />
          </label>
          <button
            suppressHydrationWarning
            className="h-11 w-full rounded-md bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500"
          >
            Sign In
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-slate-400">
          <Link href="/recover" className="text-sky-300 hover:text-sky-200">
            Forgot password?
          </Link>
        </p>
        <p className="mt-5 text-center text-sm text-slate-400">
          <Link href="/" className="text-sky-300 hover:text-sky-200">
            Continue read-only
          </Link>
        </p>
      </section>
    </main>
  );
}
