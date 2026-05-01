import { AuthService } from "./auth.service.js";

describe("AuthService", () => {
  it("authenticates valid token", () => {
    const service = new AuthService();
    expect(service.authenticate("token")).toBe(true);
  });

  it("rejects empty token", () => {
    const service = new AuthService();
    expect(service.authenticate("")).toBe(false);
  });
});
