import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.astro/**', '**/node_modules/**', '**/*.astro', 'playwright-report/**', 'test-results/**', '**/.wrangler/**', '**/worker-configuration.d.ts'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Mock-heavy Worker specs build async fakes and assert on bound mock functions.
    files: ['apps/worker/src/**/*.spec.ts'],
    rules: { '@typescript-eslint/require-await': 'off', '@typescript-eslint/unbound-method': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
