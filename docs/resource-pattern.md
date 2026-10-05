# Resource pattern reference

Copy-pasteable skeletons for the canonical resource pattern. The rules are in `AGENTS.md` (reasons in `engineering-conventions.md`) and the decisions in the `resource-pattern` skill — this file holds the long-form code.

## Controller skeleton (five standard endpoints)

`JwtAuthGuard` and `PermissionsGuard` are global — never apply them on a
controller. Every handler declares exactly one of `@Public()`,
`@AuthenticatedOnly()`, or `@RequirePermission(...)`, or the app refuses to
boot. `@RequirePermission` brings its own Swagger responses, so no
`@ApiBearerAuth()` here either. Modelled on
`src/modules/workspaces/workspaces.controller.ts`.

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

  // `denyAsNotFound`: no grant → an empty page (list) or 404 (record), never 403.
  @Get()
  @RequirePermission('read', 'Order', { denyAsNotFound: true })
  @ApiPaginatedResponse(OrderResponseDto)
  async findPaginated(
    @Query() query: MetaQueryDto,
    @CurrentAbility() ability: AppAbility,
  ): Promise<PaginatedResponseDto<OrderResponseDto>> {
    const { data, meta } = await this.ordersService.findPaginated(query, ability);
    return { data: data.map((row) => new OrderResponseDto(row)), meta };
  }

  @Get(':id')
  @RequirePermission('read', 'Order', { denyAsNotFound: true })
  @ApiOkResponse({ type: OrderResponseDto })
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.findById(id, ability));
  }

  @Patch(':id')
  @RequirePermission('update', 'Order', { denyAsNotFound: true })
  @ApiOkResponse({ type: OrderResponseDto })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.ordersService.update(id, dto, ability, currentUser.id));
  }

  @Delete(':id')
  @RequirePermission('delete', 'Order', { denyAsNotFound: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAbility() ability: AppAbility,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.ordersService.remove(id, ability, currentUser.id);
  }
}
```

## Service skeleton (scoped list + record lookup)

Modelled on `src/modules/workspaces/workspaces.service.ts`. Reads go through
`this.prisma.scoped` (soft-delete filter) and are scoped by the caller's
ability in the query.

```ts
async findPaginated(
  query: MetaQueryDto,
  ability: AppAbility,
): Promise<{ data: Order[]; meta: PaginationMeta }> {
  const { page, perPage } = query;
  const where = this.abilityScopedQueryService.buildWhereOrEmpty(
    ability,
    'read',
    'Order',
    this.buildSearchFilter(query),
  );
  const [data, total] = await this.prisma.$transaction([
    this.prisma.scoped.order.findMany({
      where,
      orderBy: buildOrderBy(query, ['name', 'createdAt', 'updatedAt'] as const, 'createdAt'),
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    // Count the SAME scoped set, or `total` describes rows the caller can't see.
    this.prisma.scoped.order.count({ where }),
  ]);
  return { data, meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) } };
}

// A row the caller cannot read is simply not found (404), never 403.
async findById(id: string, ability: AppAbility): Promise<Order> {
  const order = await this.prisma.scoped.order.findFirst({
    where: this.abilityScopedQueryService.buildRecordWhereOrEmpty(ability, 'read', 'Order', id),
  });
  if (!order) throw Errors.resourceNotFound('Order');
  return order;
}
```

## Sort allowlist

```ts
const ORDER_SORTABLE_COLUMNS = ['name', 'createdAt', 'updatedAt'] as const;
const orderBy = buildOrderBy(query, ORDER_SORTABLE_COLUMNS, 'createdAt', SortOrder.DESC);
```

## Search where-builder

```ts
private buildSearchFilter(query: MetaQueryDto): Prisma.OrderWhereInput {
  if (!query.search) return {};
  return {
    OR: [
      { reference: { contains: query.search, mode: 'insensitive' } },
      { customer: { name: { contains: query.search, mode: 'insensitive' } } },
    ],
  };
}
```

Pass it into `buildWhereOrEmpty` (above) so `findMany` and `count` share one `where` and `meta.total` reflects the filtered set.

## Resource-specific list query DTO

```ts
// orders/dto/order-list-query.dto.ts
export class OrderListQueryDto extends MetaQueryDto {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsUUID() customerId?: string;
}
```

## Actor-scoped reads

Never scope by inspecting a role — there is no role on `AuthenticatedUser`, and
hand-rolled scoping is exactly how tenant boundaries leak. Scope in the QUERY,
from the caller's ability, as the service skeleton above does.
`AbilityScopedQueryService` is the only place allowed to build that filter (an
ESLint rule enforces it: composing an `accessibleBy` fragment by hand can
silently return every row — see `src/common/authorization/README.md`).

A new subject must first be added to `WhereInputBySubject` in
`src/modules/authorization/ability-scoped-query.service.ts` and to the
permission catalog (`src/common/authorization/permission-catalog.ts`);
until then `buildWhereOrEmpty(ability, 'read', 'Order', …)` does not type-check.

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
@RequirePermission('create', 'Order')
@ApiCreatedResponse({ type: OrderResponseDto })
@UseInterceptors(FilesInterceptor('files', 50, imageUploadOptions))
async upload(
  @UploadedFiles() files: Express.Multer.File[],
  @Body('data', new ParseJsonPipe(CreateOrderDto)) dto: CreateOrderDto,
) {
  const { storageKey } = await this.fileStorage.save(files[0], 'orders');
  // Persist `storageKey` — NOT a URL. A URL embeds the bucket, the provider and
  // the access model; a key survives all three changing. On DB failure call
  // this.fileStorage.delete(storageKey) to roll back.
  //
  // To serve it later: authorize the caller FIRST, then
  // `this.fileStorage.createSignedReadUrl(storageKey)` — a short-lived URL, not
  // a permanent public one. `resolvePublicUrl()` returns null unless the
  // deployment has explicitly declared the bucket public.
}
```

## Scheduled job

A recurring job is a queue handler. Modelled on
`src/modules/auth/refresh-token-retention.handler.ts`. Declare the job name in
`JobName` (`src/common/queue/job-registry.ts`), its cadence in
`RECURRING_SCHEDULES` (`src/common/queue/recurring-schedule-registry.ts`), and
register the class as a provider in your feature module —
`QueueJobHandlerRegistry` discovers it via `@RegisterQueueJobHandler()` and
fails the boot if the wiring is incomplete. There is no in-process cron; a
decorator fires once per PROCESS, which a horizontally-scaled API multiplies.

```ts
import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../../common/email/email.service';
import { BaseJobPayloadDto } from '../../common/queue/dto/base-job-payload.dto';
import { JobName } from '../../common/queue/job-registry';
import { RegisterQueueJobHandler, type QueueJobHandler } from '../../common/queue/queue-job-handler';
import { completedJob, type JobOutcome } from '../../common/queue/queue-job-outcome';
import { formatErrorMessage } from '../../common/util/error-message.util';
import { PrismaService } from '../../prisma/prisma.service';

// orders/dto/order-reminder-payload.dto.ts
export class OrderReminderPayloadDto extends BaseJobPayloadDto {}

@Injectable()
@RegisterQueueJobHandler()
export class OrderReminderHandler implements QueueJobHandler<OrderReminderPayloadDto> {
  readonly jobName = JobName.ORDERS_REMINDER_V1;
  readonly payloadType = OrderReminderPayloadDto;

  private readonly logger = new Logger(OrderReminderHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async handle(): Promise<JobOutcome> {
    const sentCount = await this.sendDueReminders();
    return completedJob(sentCount > 0 ? `sent ${sentCount} reminder(s)` : undefined);
  }

  // Public, testable seam. Idempotent: gate on the dedupe column, stamp it
  // AFTER the side effect so a failed send retries next tick.
  async sendDueReminders(): Promise<number> {
    const dueOrders = await this.prisma.scoped.order.findMany({
      where: { reminderSentAt: null /* + due window */ },
    });
    let sentCount = 0;
    for (const order of dueOrders) {
      try {
        // 'order-reminder' must be added as an email template key.
        await this.emailService.sendTemplate('order-reminder', order.email, { /* vars */ });
        await this.prisma.order.update({ where: { id: order.id }, data: { reminderSentAt: new Date() } });
        sentCount += 1;
      } catch (error) {
        // One failed order must not stop the batch; it retries on the next tick.
        this.logger.warn(`Reminder for order ${order.id} failed: ${formatErrorMessage(error)}`);
      }
    }
    return sentCount;
  }
}
```

Note the two halves that survive from the cron shape and matter more here: the
public `sendDueReminders()` seam a spec can call directly, and the
`reminderSentAt` column. A scheduler tick is at-least-once and a failed job is
retried, so the dedupe column is what stops a retry re-sending every reminder in
the batch. There is no `NODE_ENV === 'test'` guard: tests keep workers off via
`QUEUE_WORKER_ENABLED=false` in `.env.test`. See
[`src/common/queue/README.md`](../src/common/queue/README.md).
