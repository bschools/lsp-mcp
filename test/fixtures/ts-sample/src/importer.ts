import { UserService } from "./user.service.js";

export function getServiceName(): string {
  const svc = new UserService();
  return svc.getName();
}
