import { errorJson, withSecurityHeaders } from "./_lib/http";
import type { PagesHandler } from "./_lib/types";

export const onRequest: PagesHandler = async ({ request, next }) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/open_api")) {
    return errorJson(404, "Not found", "not_found");
  }
  return withSecurityHeaders(await next());
};
