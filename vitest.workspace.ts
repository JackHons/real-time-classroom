import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node'
  }
});
