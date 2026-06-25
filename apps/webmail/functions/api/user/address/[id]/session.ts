import type { PagesHandler } from "../../../../_lib/types";
import { createAddressSession, getUserToken, json, missingUserToken, userEndpoint } from "../../../../_lib/user";

export const onRequestGet: PagesHandler<{ id: string }> = ({ request, env, params }) =>
  userEndpoint(async () => {
    const userToken = getUserToken(request);
    if (!userToken) return missingUserToken();
    const session = await createAddressSession(env, userToken, params.id);
    return json(session);
  });
