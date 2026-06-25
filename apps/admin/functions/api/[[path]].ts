import { proxyOptions, proxyToWorker, type PagesContext } from "../_lib/admin-proxy";

export const onRequestOptions = (context: PagesContext) => proxyOptions(context);

export const onRequest = (context: PagesContext) => proxyToWorker(context, "api", { admin: false });
