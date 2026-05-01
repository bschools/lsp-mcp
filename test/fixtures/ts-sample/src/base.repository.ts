import { IUserRepository } from "./interfaces.js";

export abstract class BaseRepository implements IUserRepository {
  abstract findById(id: string): unknown;
  abstract findAll(): unknown[];

  findByIds(ids: string[]): unknown[] {
    return ids.map((id) => this.findById(id));
  }
}
