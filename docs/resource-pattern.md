# Resource pattern reference

Copy-pasteable skeletons for the canonical resource pattern. Read the `nestjs-new-resource` skill first for the rules and rationale — this file holds the long-form code.

## Controller skeleton (six standard endpoints)

```ts
@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(@Body() dto: CreateOrderDto, @CurrentUser() current: AuthenticatedUser) {
    return new OrderResponseDto(await this.ordersService.create(dto, current.id));
  }

  @Get()
  async findPaginated(@Query() query: MetaQueryDto) {
    const { data, meta } = await this.ordersService.findPaginated(query);
    return { data: data.map((r) => new OrderResponseDto(r)), meta };
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

```ts
// In the controller, after validation — service stays role-agnostic.
private scopeQueryToActor(query: OrderListQueryDto, current: AuthenticatedUser) {
  if (current.role === Role.USER) {
    query.userId = current.id; // override anything the client sent
  }
  return query;
}
```

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
