import type { PagesHandler } from "../../_lib/types";
import { fetchUserProfile, getUserToken, json, missingUserToken, userEndpoint } from "../../_lib/user";

export const onRequestGet: PagesHandler = ({ request, env }) =>
  userEndpoint(async () => {
    const userToken = getUserToken(request);
    if (!userToken) return missingUserToken();
    const user = await fetchUserProfile(env, userToken);
    return json({ ok: true, user });
  });
