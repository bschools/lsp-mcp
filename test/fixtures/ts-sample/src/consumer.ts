import { UserService } from "./user.service.js";

export function makeService(): UserService {
  return new UserService();
}
