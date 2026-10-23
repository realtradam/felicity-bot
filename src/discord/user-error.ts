/** Only intentional, value-safe messages may be sent back to Discord users. */
export class UserError extends Error {
  override name = 'UserError';
}
