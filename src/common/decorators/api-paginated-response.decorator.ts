import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { PaginationMeta } from '../dto/paginated-response.dto';

// Generic type arguments are erased at runtime, so the @nestjs/swagger
// CLI plugin can't infer the item type of `PaginatedResponseDto<T>` from
// a controller's `Promise<PaginatedResponseDto<Foo>>` return type — the
// rendered schema would show `data` as an untyped array.
//
// This decorator describes the wire shape explicitly: `{ data: Foo[],
// meta: PaginationMeta }`. The envelope is spelled out inline rather than
// `$ref`-ing `PaginatedResponseDto` itself — that generic class can't be
// registered as a schema (its CLI-plugin-generated `data!: T[]` property
// is self-referential and trips Swagger's circular-dependency guard). So
// only the two concrete, non-generic types get registered via
// `ApiExtraModels`. Apply to every paginated endpoint so `/api/docs`
// shows the real item shape.
export function ApiPaginatedResponse<TModel extends Type>(model: TModel) {
  return applyDecorators(
    ApiExtraModels(PaginationMeta, model),
    ApiOkResponse({
      schema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          meta: { $ref: getSchemaPath(PaginationMeta) },
        },
        required: ['data', 'meta'],
      },
    }),
  );
}
