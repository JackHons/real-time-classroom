import { describe, expect, it } from 'vitest';
import { meetsTeacherPasswordHashPolicy, verifyTeacherPassword } from '../../../apps/server/src/auth/password.js';

describe('teacher password verifier', () => {
  const argon2idHash = '$argon2id$v=19$m=4096,t=2,p=4$PxZAeG+xbxfpZJ7licaqwg$/yN9ijvjbR4KMpZ8MdU9l3pUiUGGxmSaVSUYGPKWXTI';
  const policyCompliantHash = '$argon2id$v=19$m=65536,t=3,p=1$GyS5aoyT/uls9VKxhsyURA$oowonsh57ATUuCiXNQWUmtdad/UfwqKRmaA0u6ihJVQ';

  it('accepts only a matching Argon2id hash meeting the shared creation policy', async () => {
    await expect(verifyTeacherPassword('correct', policyCompliantHash)).resolves.toBe(true);
    await expect(verifyTeacherPassword('wrong', policyCompliantHash)).resolves.toBe(false);
  });

  it('rejects malformed, wrong-type, and downgrade hashes before verification', async () => {
    expect(meetsTeacherPasswordHashPolicy(argon2idHash)).toBe(false);
    expect(meetsTeacherPasswordHashPolicy('$argon2id$v=19$m=65536,t=3,p=1$missing-hash')).toBe(false);
    expect(meetsTeacherPasswordHashPolicy('$argon2i$v=19$m=65536,t=3,p=1$PxZAeG+xbxfpZJ7licaqwg$/yN9ijvjbR4KMpZ8MdU9l3pUiUGGxmSaVSUYGPKWXTI')).toBe(false);
    await expect(verifyTeacherPassword('correct', argon2idHash)).resolves.toBe(false);
    await expect(verifyTeacherPassword('wrong', argon2idHash)).resolves.toBe(false);
    await expect(verifyTeacherPassword('correct', '$argon2i$v=19$not-an-argon2id-hash')).resolves.toBe(false);
  });
});
