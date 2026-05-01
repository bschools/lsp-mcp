export type IAuthProvider = {
  authenticate(token: string): boolean;
};

export class AuthService {
  authenticate(token: string): boolean {
    return token.length > 0;
  }

  logout(): void {
    // no-op
  }
}
