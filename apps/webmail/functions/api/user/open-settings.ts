import type { PagesHandler } from "../../_lib/types";
import { fetchWorkerJson, json, userEndpoint } from "../../_lib/user";

export const onRequestGet: PagesHandler = ({ env }) =>
  userEndpoint(async () => {
    const settings = await fetchWorkerJson<unknown>(env, "/user_api/open_settings");
    return json({ ok: true, settings });
  });
