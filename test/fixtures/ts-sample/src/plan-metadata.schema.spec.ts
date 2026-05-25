import { PlanMetadata, PLAN_VERSION } from "./plan-metadata.schema.js";

describe("plan-metadata.schema", () => {
  it("exports PLAN_VERSION", () => {
    const meta: PlanMetadata = { id: "B-1", title: "test" };
    expect(PLAN_VERSION).toBeDefined();
    expect(meta.id).toBe("B-1");
  });
});
