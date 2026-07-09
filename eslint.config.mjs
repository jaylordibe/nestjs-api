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
  // Authorization guardrail.
  //
  // `accessibleBy` turns a CASL ability into a Prisma `where`, and the way that
  // fragment is composed is a security boundary, not a style choice: Prisma
  // SILENTLY DROPS an empty `OR: []` when it sits inside an `AND` array, so the
  // obvious merge — `{ AND: [callerWhere, fragment] }` — returns EVERY ROW to a
  // caller who holds no rules. (Verified against Prisma 7 + Postgres 16.)
  //
  // `AbilityScopedQueryService` is the single place that composition is
  // written, spec-locked by shape, and fails closed twice over. Nowhere else
  // may reach for `@casl/prisma`.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/modules/authorization/ability-scoped-query.service.ts',
      'src/modules/authorization/ability.factory.ts',
      'src/common/authorization/app-ability.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@casl/prisma',
              message:
                'Do not build Prisma filters from an ability by hand — an empty `OR: []` nested inside `AND` is silently dropped by Prisma and leaks every row. Use AbilityScopedQueryService (buildWhere / buildWhereOrEmpty / buildRecordWhere). See src/common/authorization/README.md.',
            },
          ],
        },
      ],
    },
  },
  // Layering guardrail — MUST come after the @casl/prisma block above.
  //
  // ESLint flat config merges rules BY NAME, last match wins. Both blocks
  // configure `no-restricted-imports`, so a `src/common/**` file matches both
  // and only the LAST one applies. This block therefore restates the
  // `@casl/prisma` restriction alongside the layering one — dropping it here
  // would silently un-restrict CASL inside `common/`.
  //
  // The layering rule: `src/common/` is the leaf layer. `src/modules/` builds on
  // it, never the reverse. A `common/` file importing from `modules/` inverts
  // the dependency graph and is how import cycles start. Added after
  // `PermissionsGuard` (which needs AbilityFactory + PermissionLoaderService)
  // was written into `common/guards/`; it now lives in
  // `modules/authorization/guards/`. Pure metadata — decorators, DTOs, enums,
  // errors, the permission catalog — stays in `common/` precisely because it
  // depends on nothing.
  {
    files: ['src/common/**/*.ts'],
    ignores: ['src/common/authorization/app-ability.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@casl/prisma',
              message:
                'Do not build Prisma filters from an ability by hand — an empty `OR: []` nested inside `AND` is silently dropped by Prisma and leaks every row. Use AbilityScopedQueryService. See src/common/authorization/README.md.',
            },
          ],
          patterns: [
            {
              group: ['**/modules/*', '**/modules/**'],
              message:
                'src/common/ must not import from src/modules/ — common is the leaf layer that modules build on. Move code that needs a service into src/modules/.',
            },
          ],
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
