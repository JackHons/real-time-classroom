import argon2 from 'argon2';

/** Task 9 owns first-run hash creation; Task 3 only verifies an existing Argon2id setting. */
export async function verifyTeacherPassword(password: string, storedHash: string | undefined): Promise<boolean> {
  if (storedHash === undefined || !storedHash.startsWith('$argon2id$') || password.length === 0) return false;
  try {
    return await argon2.verify(storedHash, password);
  } catch {
    return false;
  }
}
