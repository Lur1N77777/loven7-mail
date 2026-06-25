type PagesHandler = (context: { request: Request }) => Response | Promise<Response>;

export const onRequestGet: PagesHandler = async ({ request }) => {
  const source = new URL(request.url);
  const target = new URL("/", source.origin);
  const code = source.searchParams.get("code") || "";
  const state = source.searchParams.get("state") || "";
  const error = source.searchParams.get("error") || "";
  if (code) target.searchParams.set("oauth_code", code);
  if (state) target.searchParams.set("oauth_state", state);
  if (error) target.searchParams.set("oauth_error", error);
  return Response.redirect(target.toString(), 302);
};
