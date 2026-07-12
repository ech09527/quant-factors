/** 将 API / health / generate 转发到 factor-ideas Worker（Service Binding）。 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);
  if (
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname === "/generate" ||
    pathname === "/run-validation-batch" ||
    pathname === "/run-factor-validation-batch" ||
    pathname === "/run-test-factor-validation-batch" ||
    pathname === "/run-jupyter-execution-queue-reconcile" ||
    pathname === "/reset-test-factor-validation" ||
    pathname === "/run-kernel-cleanup"
  ) {
    if (!env.FACTOR_IDEAS) {
      return new Response(
        JSON.stringify({ ok: false, error: "FACTOR_IDEAS binding missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return env.FACTOR_IDEAS.fetch(request);
  }
  return next();
}
