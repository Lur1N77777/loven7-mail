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
    return errorJson(403, "普通用户无发信权限，请联系管理员处理发信需求。", "user_send_access_not_allowed");
  });
