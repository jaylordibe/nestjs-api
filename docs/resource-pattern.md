# Resource pattern reference

Copy-pasteable skeletons for the canonical resource pattern. Read the `nestjs-new-resource` skill first for the rules and rationale — this file holds the long-form code.

## Controller skeleton (five standard endpoints)

`JwtAuthGuard` and `PermissionsGuard` are global — never apply them on a
controller. Every handler declares exactly one of `@Public()`,
`@AuthenticatedOnly()`, or `@RequirePermission(...)`, or the app refuses to
boot. `@RequirePermission` brings its own Swagger responses, so no
`@ApiBearerAuth()` here either.

```ts
@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @RequirePermission('create', 'Order')
  @ApiCreatedResponse({ type: OrderResponseDto })
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.create(dto, currentUser.id));
  }

  // `denyAsNotFound`: a caller with no grant sees an empty page, not a 403.
  @Get()
  @RequirePermission('read', 'Order', { denyAsNotFound: true })
  @ApiPaginatedResponse(OrderResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    const { data, meta } = await this.ordersService.findPaginated(query, ability);
    return { data: data.map((order) => new OrderResponseDto(order)), meta };
  }

  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return new OrderResponseDto(await this.ordersService.findById(id));
  }

  @Patch(':id')
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateOrderDto, @CurrentUser() current: AuthenticatedUser) {
    return new OrderResponseDto(await this.ordersService.update(id, dto, current.id));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() current: AuthenticatedUser): Promise<void> {
    await this.ordersService.remove(id, current.id);
  }
}
```

## Service skeleton (findPaginated builds its query via buildListArgs)

```ts
async findPaginated(query: MetaQueryDto): Promise<{ data: Order[]; meta: PaginationMeta }> {
  const { page, perPage } = query;
  const args = this.buildListArgs(query);
  const [data, total] = await this.prisma.$transaction([
    this.prisma.order.findMany({ ...args, skip: (page - 1) * perPage, take: perPage }),
    this.prisma.order.count(),
  ]);
  return { data, meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) } };
}

// Single source of truth for findPaginated's sort allowlist + (future)
// search clause.
private buildListArgs(query: MetaQueryDto): { orderBy: Prisma.OrderOrderByWithRelationInput } {
  return { orderBy: buildOrderBy(query, ['name', 'createdAt', 'updatedAt'] as const, 'createdAt') };
}

async findById(id: string): Promise<Order> {
  const row = await this.findByIdOrNull(id);
  if (!row) throw Errors.resourceNotFound('Order');
  return row;
}

findByIdOrNull(id: string): Promise<Order | null> {
  return this.prisma.order.findUnique({ where: { id } });
}
```

## Sort allowlist

```ts
const ORDER_SORTABLE_COLUMNS = ['name', 'createdAt', 'updatedAt'] as const;
const orderBy = buildOrderBy(query, ORDER_SORTABLE_COLUMNS, 'createdAt', SortOrder.DESC);
```

## Search where-builder

```ts
private buildSearchWhere(term: string | undefined): Prisma.OrderWhereInput | undefined {
  const t = term?.trim();
  if (!t) return undefined;
  return { OR: [
    { reference: { contains: t, mode: 'insensitive' } },
    { customer: { name: { contains: t, mode: 'insensitive' } } },
  ]};
}
```

Apply the same `where` to both `findMany` and `count` so `meta.total` reflects the filtered set.

## Resource-specific list query DTO

```ts
// orders/dto/order-list-query.dto.ts
export class OrderListQueryDto extends MetaQueryDto {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsUUID() customerId?: string;
}
```

## Actor-scoped list endpoint

Never scope by inspecting a role — there is no role on `AuthenticatedUser`, and
hand-rolled scoping is exactly how tenant boundaries leak. Scope in the QUERY,
from the caller's ability. `AbilityScopedQueryService` is the only place allowed
to build that filter (an ESLint rule enforces it: composing an `accessibleBy`
fragment by hand can silently return every row — see
`src/common/authorization/README.md`).

```ts
// In the service. The ability decides which rows exist for this caller:
// their own, their tenant's, or everything for a platform admin.
async findPaginated(
  query: MetaQueryDto,
  ability: AppAbility,
): Promise<{ data: Order[]; meta: PaginationMeta }> {
  const where = this.abilityScopedQueryService.buildWhereOrEmpty(
    ability,
    'read',
    'Order',
    this.buildSearchFilter(query),
  );
  const [data, total] = await this.prisma.$transaction([
    this.prisma.scoped.order.findMany({ where, ...this.buildListArgs(query) }),
    // Count the SAME scoped set, or `total` describes rows the caller can't see.
    this.prisma.scoped.order.count({ where }),
  ]);
  ...
}
```

Fetching one record: `buildRecordWhereOrEmpty` + `findFirst` → an unreachable
row is simply **not found** (404), never 403. A 403 there would confirm the
record exists. If the caller CAN read it but may not act on it, that is a 403,
raised by `permissionCheckService.assertCan` against the loaded row.

## Response DTO

```ts
export class OrderResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  @ApiHideProperty() @Exclude() createdBy!: string | null;
  @ApiHideProperty() @Exclude() updatedBy!: string | null;
  @ApiHideProperty() @Exclude() deletedAt!: Date | null; // only if soft-delete
  @ApiHideProperty() @Exclude() deletedBy!: string | null;
  isActive!: boolean; // only if resource has suspension
  @ApiHideProperty() @Exclude() secretColumn!: string | null;
  constructor(row: Order) { Object.assign(this, row); }
}
```

## Throwing errors (use the Errors factory, never raw `new *Exception`)

```ts
import { Errors } from '../../common/errors/errors';

throw Errors.resourceNotFound('Order');            // 404, details { resource: 'Order' }
throw Errors.resourceConflict('Order already shipped'); // 409
throw Errors.badRequest('amount must be positive');     // 400
throw Errors.currentPasswordIncorrect();           // 401, token stays valid
throw Errors.adminSelfTargetForbidden('Use /me/... instead'); // 403
```

ESLint (`no-restricted-syntax`) rejects `new BadRequestException(...)` etc. anywhere outside `src/common/errors/`.

## Multipart upload + JSON DTO body

```ts
@Post('upload')
@UseInterceptors(FilesInterceptor('files', 50, imageUploadOptions))
async upload(
  @UploadedFiles() files: Express.Multer.File[],
  @Body('data', new ParseJsonPipe(CreateOrderDto)) dto: CreateOrderDto,
) {
  const { url, storageKey } = await this.fileStorage.save(files[0], 'orders');
  // persist `url`; on DB failure call this.fileStorage.delete(storageKey) to roll back
}
```

## Scheduled job

```ts
@Injectable()
export class ReminderJob {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  // Public, testable seam. Idempotent: gate on the dedupe column, stamp
  // it AFTER the side effect so a failed send retries next tick.
  async sendDueReminders(): Promise<void> {
    if (this.configService.get('nodeEnv') === 'test') return;
    const due = await this.prisma.order.findMany({ where: { reminderSentAt: null /* + due window */ } });
    for (const order of due) {
      try {
        await this.emailService.sendTemplate('reminder', order.email, { /* vars */ });
        await this.prisma.order.update({ where: { id: order.id }, data: { reminderSentAt: new Date() } });
      } catch (err) {
        // Per-item error must not kill the loop.
      }
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  handleCron(): Promise<void> {
    return this.sendDueReminders();
  }
}
```
