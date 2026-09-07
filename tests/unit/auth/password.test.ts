import { describe, expect, it } from 'vitest';
import { verifyTeacherPassword } from '../../../apps/server/src/auth/password.js';

describe('teacher password verifier', () => {
  const argon2idHash = '$argon2id$v=19$m=4096,t=2,p=4$PxZAeG+xbxfpZJ7licaqwg$/yN9ijvjbR4KMpZ8MdU9l3pUiUGGxmSaVSUYGPKWXTI';

  it('accepts only a matching Argon2id hash', async () => {
    await expect(verifyTeacherPassword('correct', argon2idHash)).resolves.toBe(true);
    await expect(verifyTeacherPassword('wrong', argon2idHash)).resolves.toBe(false);
    await expect(verifyTeacherPassword('correct', '$argon2i$v=19$not-an-argon2id-hash')).resolves.toBe(false);
  });
});
