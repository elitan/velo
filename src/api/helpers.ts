export function assertOk(result: { ok: boolean; message: string }): void {
  if (!result.ok) {
    throw new Error(result.message);
  }
}
