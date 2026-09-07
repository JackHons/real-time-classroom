import argon2 from 'argon2';

/**
 * The one canonical Argon2id policy. Task 9's first-run writer must pass these
 * values to argon2.hash; this verifier rejects persisted hashes below them.
 */
export const TEACHER_PASSWORD_ARGON2_POLICY = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
});

type Argon2idParameters = Readonly<{ version: number; memoryCost: number; timeCost: number; parallelism: number }>;
const ARGON2ID_HASH = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$[^$]+\$[^$]+$/;

/** Task 9 owns first-run hash creation; Task 3 verifies the same Argon2id policy. */
export async function verifyTeacherPassword(password: string, storedHash: string | undefined): Promise<boolean> {
  if (password.length === 0 || !meetsTeacherPasswordHashPolicy(storedHash)) return false;
  try {
    return await argon2.verify(storedHash as string, password);
  } catch {
    return false;
  }
}

export function meetsTeacherPasswordHashPolicy(storedHash: string | undefined): boolean {
  if (storedHash === undefined) return false;
  const match = ARGON2ID_HASH.exec(storedHash);
  if (match === null) return false;
  const parameters: Argon2idParameters = {
    version: Number(match[1]), memoryCost: Number(match[2]), timeCost: Number(match[3]), parallelism: Number(match[4])
  };
  return Object.values(parameters).every(Number.isSafeInteger)
    && parameters.version === 19
    && parameters.memoryCost >= TEACHER_PASSWORD_ARGON2_POLICY.memoryCost
    && parameters.timeCost >= TEACHER_PASSWORD_ARGON2_POLICY.timeCost
    && parameters.parallelism >= TEACHER_PASSWORD_ARGON2_POLICY.parallelism;
}
