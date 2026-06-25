import { errorJson } from "../../../../_lib/http";
import type { PagesHandler } from "../../../../_lib/types";
import {
  getUserToken,
  missingUserToken,
  userEndpoint,
} from "../../../../_lib/user";

export const onRequestPost: PagesHandler<{ id: string }> = ({ request }) =>
  userEndpoint(async () => {
    const userToken = getUserToken(request);
    if (!userToken) return missingUserToken();
    return errorJson(403, "普通用户无发信权限，请使用管理员后台发信。", "user_send_not_allowed");
  });
