import { UserService } from "./user.service.js";

export function formatUserName(service: UserService): string {
  return service.getName().toUpperCase();
}
