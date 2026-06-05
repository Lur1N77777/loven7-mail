import { json } from "../_lib/http";
import { runtimeDiagnostics } from "../_lib/runtime";
import type { PagesHandler } from "../_lib/types";

export const onRequestGet: PagesHandler = ({ env }) => {
  const diagnostics = runtimeDiagnostics(env as unknown as Record<string, unknown>);
  return json({
    ...diagnostics,
    checkedAt: new Date().toISOString(),
  });
};
