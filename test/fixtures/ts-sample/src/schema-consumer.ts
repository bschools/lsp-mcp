import { PlanMetadata, PLAN_VERSION } from "./plan-metadata.schema.js";

export function describePlan(meta: PlanMetadata): string {
  return `${meta.id} (v${PLAN_VERSION}): ${meta.title}`;
}
