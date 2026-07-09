import { PartialType } from '@nestjs/swagger';
import { CreateBusinessDto } from './create-business.dto';

// `@nestjs/swagger`'s PartialType, not `@nestjs/mapped-types` — the latter
// makes the inherited DTO render empty in /api/docs.
export class UpdateBusinessDto extends PartialType(CreateBusinessDto) {}
