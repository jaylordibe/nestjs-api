// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  // Channel every domain exception through the Errors factory. Direct
  // construction of Nest's built-in HttpException subclasses bypasses
  // the standard error envelope (errorCode, details). The factory at
  // src/common/errors/errors.ts is the one place allowed to do this;
  // everywhere else must call `Errors.*`. See src/common/errors/README.md.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/common/errors/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "NewExpression[callee.name=/^(BadRequestException|UnauthorizedException|ForbiddenException|NotFoundException|ConflictException|ServiceUnavailableException)$/]",
          message:
            'Do not construct HttpException subclasses directly. Use the `Errors.*` factory in src/common/errors/errors.ts so the response carries a stable errorCode. See src/common/errors/README.md.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
