import { BaseRepository } from "./base.repository.js";

export class UserRepository extends BaseRepository {
  findById(id: string): unknown {
    return { id };
  }

  findAll(): unknown[] {
    return [];
  }
}
