export type IUserRepository = {
  findById(id: string): unknown;
  findAll(): unknown[];
};
