/** 将 API / health / generate 转发到 factor-ideas Worker（Service Binding）。 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);
  if (
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname === "/generate"
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
