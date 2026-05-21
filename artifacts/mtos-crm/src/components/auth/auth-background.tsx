/**
 * Decorative full-bleed backdrop for the unauthenticated auth pages.
 *
 * A deep navy gradient with soft glowing colour blobs, a faint grid
 * texture, and a vignette for depth — the modern SaaS sign-in look. The
 * white auth card floats on top. Purely presentational: it sits at -z-10
 * and is pointer-events-none so it never intercepts clicks.
 */
export function AuthBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {/* Base gradient. */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900" />

      {/* Soft glowing colour blobs. */}
      <div className="absolute -left-32 -top-32 h-[30rem] w-[30rem] rounded-full bg-blue-500/25 blur-[120px]" />
      <div className="absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-emerald-500/20 blur-[120px]" />
      <div className="absolute left-1/2 top-1/2 h-[24rem] w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/25 blur-[130px]" />

      {/* Faint grid texture. */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
          backgroundSize: "46px 46px",
        }}
      />

      {/* Vignette for depth. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 35%, rgba(2,6,23,0.78) 100%)",
        }}
      />
    </div>
  );
}
