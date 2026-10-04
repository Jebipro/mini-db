import { InternalError } from './errors.js';

/** Exhaustiveness check for discriminated unions. */
export function assertNever(x: never, what = 'value'): never {
  throw new InternalError('INVARIANT_VIOLATION', `unexpected ${what}: ${JSON.stringify(x)}`);
}

/** Internal invariant (I13..I16 etc.). Violations are bugs and fail immediately. */
export function invariant(cond: unknown, message: string): asserts cond {
  if (!cond) throw new InternalError('INVARIANT_VIOLATION', message);
}
