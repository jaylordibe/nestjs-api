import { PartialType } from '@nestjs/swagger';
import { CreateWorkspaceDto } from './create-workspace.dto';

// `@nestjs/swagger`'s PartialType, not `@nestjs/mapped-types` — the latter
// makes the inherited DTO render empty in /api/docs.
export class UpdateWorkspaceDto extends PartialType(CreateWorkspaceDto) {}
