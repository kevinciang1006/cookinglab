"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || pending) return;

    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok) {
        router.push("/");
        router.refresh();
      } else {
        setError(data.error ?? "Wrong password.");
      }
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center px-4">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-muted">
        Cooking Lab
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Log in</h1>

      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={pending}
          autoFocus
          placeholder="Password"
          className="w-full rounded-md border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending || !password}
          className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-paper transition-opacity disabled:opacity-40"
        >
          {pending ? "Checking…" : "Enter"}
        </button>
        {error && <p className="text-sm italic text-ink-muted">{error}</p>}
      </form>
    </main>
  );
}
