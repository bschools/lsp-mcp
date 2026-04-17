import { UserService } from "./user.service.js";

describe("UserService", () => {
  it("returns a name", () => {
    const service = new UserService();
    expect(service.getName()).toBe("user");
  });
});
